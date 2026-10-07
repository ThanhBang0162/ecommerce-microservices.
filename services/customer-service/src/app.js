const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Thieu DATABASE_URL');
  process.exit(1);
}

const definition = loader.loadSync(
  path.join(__dirname, '../../../proto/customer.proto'),
  {
    keepCase: true,
    defaults: true,
    oneofs: true
  }
);

const proto = grpc.loadPackageDefinition(definition).customer;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000
});

const server = new grpc.Server();

function validId(value) {
  return Number.isInteger(value) && value > 0;
}

function fail(callback, code, details) {
  callback({ code, details });
}

function databaseError(error, callback) {
  console.error('Customer DB error:', error.message);

  fail(
    callback,
    grpc.status.INTERNAL,
    'Khong the xu ly du lieu khach hang'
  );
}

async function findCustomer(uid) {
  const result = await pool.query(
    `SELECT c.uid, c.fullname, c.mid, m.mname, m.score
     FROM customers c
     JOIN memberships m ON m.mid = c.mid
     WHERE c.uid = $1`,
    [uid]
  );

  return result.rows[0];
}

async function getCustomer(call, callback) {
  const { uid } = call.request;

  if (!validId(uid)) {
    return fail(
      callback,
      grpc.status.INVALID_ARGUMENT,
      'UID khong hop le'
    );
  }

  try {
    const customer = await findCustomer(uid);

    if (!customer) {
      return fail(
        callback,
        grpc.status.NOT_FOUND,
        'Customer khong ton tai'
      );
    }

    callback(null, customer);
  } catch (error) {
    databaseError(error, callback);
  }
}

async function createCustomer(call, callback) {
  const { uid } = call.request;
  const fullname = (call.request.fullname || '').trim();

  if (
    !validId(uid) ||
    !fullname ||
    fullname.length > 100
  ) {
    return fail(
      callback,
      grpc.status.INVALID_ARGUMENT,
      'UID hoac fullname khong hop le'
    );
  }

  try {
    const result = await pool.query(
      `WITH inserted AS (
         INSERT INTO customers (uid, fullname, mid)
         VALUES (
           $1,
           $2,
           (SELECT mid FROM memberships WHERE mname = 'STANDARD')
         )
         RETURNING uid, fullname, mid
       )
       SELECT c.uid, c.fullname, c.mid, m.mname, m.score
       FROM inserted c
       JOIN memberships m ON m.mid = c.mid`,
      [uid, fullname]
    );

    callback(null, result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return fail(
        callback,
        grpc.status.ALREADY_EXISTS,
        'Customer da ton tai'
      );
    }

    databaseError(error, callback);
  }
}

async function updateCustomer(call, callback) {
  const { uid } = call.request;
  const fullname = (call.request.fullname || '').trim();

  // optional mid cho phép giữ nguyên hạng khi không gửi mid.
  const hasMid = Object.prototype.hasOwnProperty.call(
    call.request,
    'mid'
  );

  if (
    !validId(uid) ||
    !fullname ||
    fullname.length > 100 ||
    (hasMid && !validId(call.request.mid))
  ) {
    return fail(
      callback,
      grpc.status.INVALID_ARGUMENT,
      'Du lieu cap nhat khong hop le'
    );
  }

  try {
    const result = await pool.query(
      `WITH updated AS (
         UPDATE customers
         SET fullname = $2,
             mid = COALESCE($3::integer, mid)
         WHERE uid = $1
         RETURNING uid, fullname, mid
       )
       SELECT c.uid, c.fullname, c.mid, m.mname, m.score
       FROM updated c
       JOIN memberships m ON m.mid = c.mid`,
      [
        uid,
        fullname,
        hasMid ? call.request.mid : null
      ]
    );

    if (!result.rows[0]) {
      return fail(
        callback,
        grpc.status.NOT_FOUND,
        'Customer khong ton tai'
      );
    }

    callback(null, result.rows[0]);
  } catch (error) {
    if (error.code === '23503') {
      return fail(
        callback,
        grpc.status.INVALID_ARGUMENT,
        'Membership khong ton tai'
      );
    }

    databaseError(error, callback);
  }
}

async function getMembership(call, callback) {
  const { mid } = call.request;

  if (!validId(mid)) {
    return fail(
      callback,
      grpc.status.INVALID_ARGUMENT,
      'MID khong hop le'
    );
  }

  try {
    const result = await pool.query(
      'SELECT mid, mname, score FROM memberships WHERE mid = $1',
      [mid]
    );

    if (!result.rows[0]) {
      return fail(
        callback,
        grpc.status.NOT_FOUND,
        'Membership khong ton tai'
      );
    }

    callback(null, result.rows[0]);
  } catch (error) {
    databaseError(error, callback);
  }
}

async function health(call, callback) {
  try {
    await pool.query('SELECT 1');
    callback(null, { status: 'UP' });
  } catch (error) {
    fail(
      callback,
      grpc.status.UNAVAILABLE,
      'Customer database unavailable'
    );
  }
}

server.addService(proto.CustomerService.service, {
  GetCustomer: getCustomer,
  CreateCustomer: createCustomer,
  UpdateCustomer: updateCustomer,
  GetMembership: getMembership,
  Health: health
});

let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;

  console.log('Stopping Customer Service...');

  const timer = setTimeout(() => {
    server.forceShutdown();
  }, 5000);

  timer.unref();

  await new Promise((resolve) => {
    server.tryShutdown(resolve);
  });

  clearTimeout(timer);
  await pool.end();
}

async function main() {
  await pool.query('SELECT 1');
  console.log('Customer DB connected');

  const address =
    `${process.env.GRPC_HOST || '127.0.0.1'}:` +
    `${process.env.GRPC_PORT || '50052'}`;

  await new Promise((resolve, reject) => {
    server.bindAsync(
      address,
      grpc.ServerCredentials.createInsecure(),
      (error) => {
        if (error) return reject(error);
        resolve();
      }
    );
  });

  console.log(`Customer gRPC running at ${address}`);
}

process.on('SIGINT', () => {
  shutdown().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
});

process.on('SIGTERM', () => {
  shutdown().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
});

main().catch(async (error) => {
  console.error('Customer startup failed:', error.message);
  server.forceShutdown();
  await pool.end();
  process.exitCode = 1;
});