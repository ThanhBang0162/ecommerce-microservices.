const path = require('node:path');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

const { Pool } = require('pg');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

if (!process.env.DATABASE_URL) {
  throw new Error('Thieu DATABASE_URL');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 2
});

pool.on('error', error => {
  console.error('Auth DB pool error:', error.message);
});

const definition = loader.loadSync(
  path.join(__dirname, '../../../proto/customer.proto'),
  {
    keepCase: true,
    defaults: true,
    oneofs: true
  }
);

const proto = grpc.loadPackageDefinition(definition).customer;

const customerClient = new proto.CustomerService(
  process.env.CUSTOMER_GRPC_ADDRESS || '127.0.0.1:50052',
  grpc.credentials.createInsecure()
);

let stopping = false;
let wakeUp;

function invoke(method, request) {
  return new Promise((resolve, reject) => {
    customerClient[method](
      request,
      { deadline: new Date(Date.now() + 5000) },
      (error, response) => {
        if (error) return reject(error);
        resolve(response);
      }
    );
  });
}

function pause() {
  return new Promise(resolve => {
    const timer = setTimeout(done, 2000);

    function done() {
      clearTimeout(timer);
      wakeUp = undefined;
      resolve();
    }

    wakeUp = done;

    if (stopping) done();
  });
}

async function provisionOne() {
  const client = await pool.connect();
  let discard = false;

  try {
    await client.query('BEGIN');

    const result = await client.query(`
      SELECT uid, fullname
      FROM customer_provisioning
      WHERE completed_at IS NULL
      ORDER BY created_at, uid
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    const task = result.rows[0];

    if (!task) {
      await client.query('COMMIT');
      return false;
    }

    let customer;

    try {
      customer = await invoke('CreateCustomer', {
        uid: task.uid,
        fullname: task.fullname
      });
    } catch (error) {
      if (error.code !== grpc.status.ALREADY_EXISTS) {
        throw error;
      }

      // Lan truoc co the da tao ho so nhung mat phan hoi.
      // Doc lai, khong ghi de ten hoac membership da duoc cap nhat.
      customer = await invoke('GetCustomer', {
        uid: task.uid
      });
    }

    if (customer.uid !== task.uid) {
      throw new Error('Customer tra ve UID khong dung');
    }

    await client.query(`
      UPDATE customer_provisioning
      SET completed_at = NOW()
      WHERE uid = $1
    `, [task.uid]);

    await client.query('COMMIT');

    console.log(
      'Customer provisioned:',
      customer.uid,
      '- Membership:',
      customer.mname,
      '- Score:',
      customer.score
    );

    return true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }

    throw error;
  } finally {
    client.release(discard);
  }
}

async function main() {
  try {
    await pool.query('SELECT 1');
    console.log('Customer provisioning worker started');

    while (!stopping) {
      try {
        const processed = await provisionOne();

        if (!processed && !stopping) {
          await pause();
        }
      } catch (error) {
        console.error('Customer provisioning failed:', error.message);

        if (!stopping) {
          await pause();
        }
      }
    }
  } finally {
    customerClient.close();
    await pool.end();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (wakeUp) wakeUp();
  });
}

main().catch(error => {
  console.error('Provisioning worker failed:', error.message);
  process.exitCode = 1;
});