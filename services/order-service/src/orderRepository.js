const grpc = require('@grpc/grpc-js');
const { pool } = require('./db');

function validId(value) {
  return Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647;
}

function serviceError(code, details) {
  const error = new Error(details);
  error.code = code;
  error.details = details;
  return error;
}

function serializeOrder(row, items) {
  return {
    oid: row.oid,
    uid: row.uid,
    discount: row.discount,
    total_amount: row.total_amount,
    created_at: new Date(row.created_at).toISOString(),
    items
  };
}

async function getOrder(oid, database = pool) {
  if (!validId(oid)) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      'OID khong hop le'
    );
  }

  // Mot cau query de doc don va chi tiet nhat quan.
  const result = await database.query(`
    SELECT
      o.oid,
      o.uid,
      o.discount,
      o.total_amount,
      o.created_at,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'pid', d.pid,
            'qty', d.qty,
            'unit_price', d.unit_price::text
          ) ORDER BY d.pid
        ) FILTER (WHERE d.pid IS NOT NULL),
        '[]'::jsonb
      ) AS items
    FROM orders o
    LEFT JOIN order_details d ON d.oid = o.oid
    WHERE o.oid = $1
    GROUP BY o.oid
  `, [oid]);

  if (!result.rows.length) {
    throw serviceError(
      grpc.status.NOT_FOUND,
      'Order khong ton tai'
    );
  }

  const row = result.rows[0];
  return serializeOrder(row, row.items);
}

async function listOrders(uid, database = pool) {
  if (!validId(uid)) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      'UID khong hop le'
    );
  }

  const result = await database.query(`
    SELECT
      o.oid,
      o.uid,
      o.discount,
      o.total_amount,
      o.created_at,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'pid', d.pid,
            'qty', d.qty,
            'unit_price', d.unit_price::text
          ) ORDER BY d.pid
        ) FILTER (WHERE d.pid IS NOT NULL),
        '[]'::jsonb
      ) AS items
    FROM orders o
    LEFT JOIN order_details d ON d.oid = o.oid
    WHERE o.uid = $1
    GROUP BY o.oid
    ORDER BY o.oid DESC
  `, [uid]);

  return {
    items: result.rows.map(row => serializeOrder(row, row.items))
  };
}

module.exports = {
  validId,
  serviceError,
  getOrder,
  listOrders
};