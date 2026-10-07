const { randomUUID } = require('node:crypto');
const grpc = require('@grpc/grpc-js');

const { pool, transaction } = require('./db');
const {
  getCustomer,
  reserveStock,
  releaseStock
} = require('./grpcClients');
const {
  validId,
  serviceError,
  getOrder
} = require('./orderRepository');
const { calculateTotals } = require('./money');

function normalizeRequest(request) {
  const { uid, request_id, items } = request;

  if (!validId(uid)) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      'UID khong hop le'
    );
  }

  if (
    typeof request_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(request_id)
  ) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      'request_id phai la UUID'
    );
  }

  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > 50
  ) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      'Don hang can tu 1 den 50 san pham'
    );
  }

  const seen = new Set();

  const normalizedItems = items.map(item => {
    if (!validId(item.pid) || !validId(item.qty)) {
      throw serviceError(
        grpc.status.INVALID_ARGUMENT,
        'PID hoac so luong khong hop le'
      );
    }

    if (seen.has(item.pid)) {
      throw serviceError(
        grpc.status.INVALID_ARGUMENT,
        'Khong duoc lap PID trong cung don hang'
      );
    }

    seen.add(item.pid);

    return {
      pid: item.pid,
      qty: item.qty
    };
  }).sort((a, b) => a.pid - b.pid);

  return {
    uid,
    request_id: request_id.toLowerCase(),
    items: normalizedItems
  };
}

function sameItems(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((item, index) =>
      item.pid === right[index].pid &&
      item.qty === right[index].qty
    );
}

async function withRequestLock(requestId, work) {
  const connection = await pool.connect();

  let locked = false;
  let discard = false;
  let connectionError;

  const onError = error => {
    connectionError = error;
    discard = true;
  };

  connection.on('error', onError);

  try {
    const result = await connection.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [requestId]
    );

    locked = result.rows[0].locked;

    if (!locked) {
      throw serviceError(
        grpc.status.ABORTED,
        'Yeu cau dang duoc xu ly; hay thu lai voi cung request_id'
      );
    }

    if (connectionError) {
      throw connectionError;
    }

    return await work();
  } finally {
    if (locked && !connectionError) {
      try {
        await connection.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [requestId]
        );
      } catch {
        discard = true;
      }
    }

    connection.removeListener('error', onError);
    connection.release(discard);
  }
}

async function loadAttempt(requestId) {
  const result = await pool.query(
    'SELECT * FROM order_attempts WHERE request_id = $1',
    [requestId]
  );

  return result.rows[0];
}

async function prepareAttempt(request) {
  return transaction(async client => {
    await client.query(`
      INSERT INTO order_attempts (request_id, uid, items)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (request_id) DO NOTHING
    `, [
      request.request_id,
      request.uid,
      JSON.stringify(request.items)
    ]);

    const result = await client.query(`
      SELECT *
      FROM order_attempts
      WHERE request_id = $1
      FOR UPDATE
    `, [request.request_id]);

    const attempt = result.rows[0];

    if (
      attempt.uid !== request.uid ||
      !sameItems(attempt.items, request.items)
    ) {
      throw serviceError(
        grpc.status.ALREADY_EXISTS,
        'request_id da duoc dung cho noi dung don hang khac'
      );
    }

    if (attempt.status === 'PROCESSING') {
      for (const item of request.items) {
        await client.query(`
          INSERT INTO inventory_tasks (
            reservation_id,
            request_id,
            pid,
            qty
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (request_id, pid) DO NOTHING
        `, [
          randomUUID(),
          request.request_id,
          item.pid,
          item.qty
        ]);
      }
    }

    return attempt;
  });
}

async function loadTasks(requestId) {
  const result = await pool.query(`
    SELECT *
    FROM inventory_tasks
    WHERE request_id = $1
    ORDER BY pid
  `, [requestId]);

  return result.rows;
}

async function cancelAttempt(requestId) {
  return transaction(async client => {
    const result = await client.query(`
      SELECT *
      FROM order_attempts
      WHERE request_id = $1
      FOR UPDATE
    `, [requestId]);

    const attempt = result.rows[0];

    if (!attempt || attempt.status === 'COMPLETED') {
      return attempt;
    }

    await client.query(`
      UPDATE order_attempts
      SET
        status = 'CANCELLED',
        updated_at = NOW()
      WHERE request_id = $1
    `, [requestId]);

    return {
      ...attempt,
      status: 'CANCELLED'
    };
  });
}

async function releaseTasks(requestId) {
  const tasks = await loadTasks(requestId);
  let firstError;

  for (const task of tasks) {
    if (task.status === 'RELEASED') {
      continue;
    }

    try {
      try {
        // PENDING cung can hoan vi phan hoi giu hang co the bi mat.
        await releaseStock(task.reservation_id, task.pid);
      } catch (error) {
        // San pham khong ton tai thi khong co kho de hoan.
        if (error.code !== grpc.status.NOT_FOUND) {
          throw error;
        }
      }

      await pool.query(`
        UPDATE inventory_tasks
        SET status = 'RELEASED'
        WHERE reservation_id = $1
      `, [task.reservation_id]);
    } catch (error) {
      firstError ||= error;

      console.error(
        'Chua hoan duoc hang:',
        task.reservation_id,
        error.message
      );
    }
  }

  if (firstError) {
    throw firstError;
  }
}

async function saveOrder(request, totals) {
  return transaction(async client => {
    const attemptResult = await client.query(`
      SELECT *
      FROM order_attempts
      WHERE request_id = $1
      FOR UPDATE
    `, [request.request_id]);

    const attempt = attemptResult.rows[0];

    if (attempt.status === 'COMPLETED') {
      return getOrder(attempt.oid, client);
    }

    if (attempt.status !== 'PROCESSING') {
      throw serviceError(
        grpc.status.FAILED_PRECONDITION,
        'Yeu cau tao don da bi huy'
      );
    }

    const taskResult = await client.query(`
      SELECT *
      FROM inventory_tasks
      WHERE request_id = $1
      ORDER BY pid
    `, [request.request_id]);

    const tasks = taskResult.rows;

    if (
      tasks.length !== request.items.length ||
      tasks.some(task => task.status !== 'RESERVED')
    ) {
      throw new Error('Chua giu du hang cho don');
    }

    const orderResult = await client.query(`
      INSERT INTO orders (uid, discount, total_amount)
      VALUES ($1, $2, $3)
      RETURNING oid
    `, [
      request.uid,
      totals.discount,
      totals.total_amount
    ]);

    const oid = orderResult.rows[0].oid;

    for (const task of tasks) {
      await client.query(`
        INSERT INTO order_details (
          oid,
          pid,
          qty,
          unit_price
        )
        VALUES ($1, $2, $3, $4)
      `, [
        oid,
        task.pid,
        task.qty,
        task.unit_price
      ]);
    }

    const order = await getOrder(oid, client);
    const eventId = randomUUID();

    await client.query(`
      INSERT INTO outbox_events (
        event_id,
        event_type,
        aggregate_id,
        payload
      )
      VALUES ($1, 'OrderCreated', $2, $3::jsonb)
    `, [
      eventId,
      oid,
      JSON.stringify({
        event_id: eventId,
        event_type: 'OrderCreated',
        ...order
      })
    ]);

    await client.query(`
      UPDATE order_attempts
      SET
        status = 'COMPLETED',
        oid = $2,
        updated_at = NOW()
      WHERE request_id = $1
    `, [request.request_id, oid]);

    return order;
  });
}

async function createOrder(input) {
  const request = normalizeRequest(input);

  return withRequestLock(request.request_id, async () => {
    const attempt = await prepareAttempt(request);

    // Don da tao: tra lai so tien da luu, khong tinh lai membership.
    if (attempt.status === 'COMPLETED') {
      return getOrder(attempt.oid);
    }

    if (attempt.status === 'CANCELLED') {
      await releaseTasks(request.request_id);

      throw serviceError(
        grpc.status.FAILED_PRECONDITION,
        'Yeu cau da bi huy; tao yeu cau moi bang request_id moi'
      );
    }

    try {
      const customer = await getCustomer(request.uid);
      const discountPercent = customer.score;

      if (
        !Number.isInteger(discountPercent) ||
        discountPercent < 0 ||
        discountPercent > 100
      ) {
        throw serviceError(
          grpc.status.FAILED_PRECONDITION,
          'Diem membership phai tu 0 den 100 de tinh giam gia'
        );
      }

      const tasks = await loadTasks(request.request_id);

      for (const task of tasks) {
        if (task.status === 'RESERVED') {
          continue;
        }

        const reservation = await reserveStock(
          task.reservation_id,
          task.pid,
          task.qty
        );

        await pool.query(`
          UPDATE inventory_tasks
          SET
            status = 'RESERVED',
            unit_price = $2
          WHERE reservation_id = $1
        `, [
          task.reservation_id,
          reservation.unit_price
        ]);
      }

      const reservedTasks = await loadTasks(request.request_id);

      // score = 10 tuong ung giam 10%.
      // orders.discount luu SO TIEN giam, khong phai ty le.
      const totals = calculateTotals(
        reservedTasks,
        discountPercent
      );

      return await saveOrder(request, totals);
    } catch (error) {
      let current;

      try {
        // COMMIT co the thanh cong nhung phan hoi bi mat.
        // Kiem tra trang thai truoc khi hoan kho.
        current = await cancelAttempt(request.request_id);
      } catch (databaseError) {
        console.error(
          'Chua xac dinh duoc trang thai don:',
          databaseError.message
        );

        throw serviceError(
          grpc.status.UNAVAILABLE,
          'Chua xac dinh ket qua; hay thu lai voi cung request_id'
        );
      }

      if (current?.status === 'COMPLETED') {
        return getOrder(current.oid);
      }

      try {
        await releaseTasks(request.request_id);
      } catch {
        throw serviceError(
          grpc.status.UNAVAILABLE,
          'Tao don that bai; he thong dang cho hoan kho'
        );
      }

      throw error;
    }
  });
}

async function recoverAttempts(includeProcessing = false) {
  const result = await pool.query(`
    SELECT a.request_id
    FROM order_attempts a
    WHERE
      ($1::boolean AND a.status = 'PROCESSING')
      OR (
        a.status = 'CANCELLED'
        AND EXISTS (
          SELECT 1
          FROM inventory_tasks t
          WHERE t.request_id = a.request_id
            AND t.status <> 'RELEASED'
        )
      )
    ORDER BY a.created_at
    LIMIT 100
  `, [includeProcessing]);

  for (const row of result.rows) {
    try {
      await withRequestLock(row.request_id, async () => {
        const attempt = await loadAttempt(row.request_id);

        if (!attempt || attempt.status === 'COMPLETED') {
          return;
        }

        await cancelAttempt(row.request_id);
        await releaseTasks(row.request_id);
      });
    } catch (error) {
      if (error.code === grpc.status.ABORTED) {
        continue;
      }

      console.error(
        'Phuc hoi don:',
        row.request_id,
        error.message
      );
    }
  }

  return result.rows.length;
}

module.exports = {
  createOrder,
  recoverAttempts
};