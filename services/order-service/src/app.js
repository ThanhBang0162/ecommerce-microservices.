const path = require('node:path');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

const { pool } = require('./db');
const {
  checkDependencies,
  closeClients
} = require('./grpcClients');
const {
  getOrder,
  listOrders
} = require('./orderRepository');
const {
  createOrder,
  recoverAttempts
} = require('./orderWorkflow');

const definition = loader.loadSync(
  path.join(__dirname, '../../../proto/order.proto'),
  {
    keepCase: true,
    defaults: true,
    oneofs: true
  }
);

const proto = grpc.loadPackageDefinition(definition).order;
const server = new grpc.Server();

let stopping = false;
let recoveryTimer;
let recoveryJob;
let shutdownPromise;

function handler(work) {
  return async (call, callback) => {
    if (stopping) {
      return callback({
        code: grpc.status.UNAVAILABLE,
        details: 'Order Service dang dung'
      });
    }

    try {
      const result = await work(call.request);
      callback(null, result);
    } catch (error) {
      console.error('Order error:', error.message);

      const isGrpcError =
        Number.isInteger(error.code) &&
        error.code >= 1 &&
        error.code <= 16;

      callback({
        code: isGrpcError ? error.code : grpc.status.INTERNAL,
        details: isGrpcError
          ? error.details || error.message
          : 'Khong the xu ly don hang'
      });
    }
  };
}

async function health() {
  try {
    await pool.query('SELECT 1');
    await checkDependencies();

    return { status: 'UP' };
  } catch {
    const error = new Error('Order hoac service phu thuoc chua san sang');
    error.code = grpc.status.UNAVAILABLE;
    throw error;
  }
}

server.addService(proto.OrderService.service, {
  CreateOrder: handler(createOrder),
  GetOrder: handler(request => getOrder(request.oid)),
  ListOrders: handler(request => listOrders(request.uid)),
  Health: handler(health)
});

function runRecovery() {
  if (stopping || recoveryJob) return recoveryJob;

  recoveryJob = recoverAttempts(true)
    .catch(error => {
      console.error('Order recovery error:', error.message);
    })
    .finally(() => {
      recoveryJob = undefined;
    });

  return recoveryJob;
}

async function stopResources() {
  stopping = true;
  clearInterval(recoveryTimer);

  console.log('Stopping Order Service...');

  // Cho cac RPC dang chay hoan tat truoc khi dong database.
  await new Promise(resolve => server.tryShutdown(resolve));

  if (recoveryJob) {
    await recoveryJob;
  }

  closeClients();
  await pool.end();
}

function shutdown() {
  shutdownPromise ||= stopResources();
  return shutdownPromise;
}

async function main() {
  const port = Number(process.env.GRPC_PORT || 50054);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('GRPC_PORT khong hop le');
  }

  await pool.query('SELECT 1');
  console.log('Order DB connected');

  await checkDependencies();
  console.log('Customer and Product connected');

  // Phuc hoi cac luot tao don bi bo do truoc khi nhan RPC moi.
  await runRecovery();

  const address =
    `${process.env.GRPC_HOST || '127.0.0.1'}:${port}`;

  await new Promise((resolve, reject) => {
    server.bindAsync(
      address,
      grpc.ServerCredentials.createInsecure(),
      error => error ? reject(error) : resolve()
    );
  });

  recoveryTimer = setInterval(runRecovery, 15000);

  console.log(`Order gRPC running at ${address}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown().catch(error => {
      console.error('Order shutdown failed:', error.message);
      process.exitCode = 1;
    });
  });
}

main().catch(async error => {
  console.error('Order startup failed:', error.message);

  stopping = true;
  clearInterval(recoveryTimer);
  server.forceShutdown();

  if (recoveryJob) {
    await recoveryJob;
  }

  closeClients();

  try {
    await pool.end();
  } catch (closeError) {
    console.error(closeError.message);
  }

  process.exitCode = 1;
});