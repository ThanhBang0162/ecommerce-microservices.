const path = require('node:path');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const mongoose = require('mongoose');

const {
  Shipment,
  initializeModels,
  serialize
} = require('./models');

const {
  startConsumer,
  stopConsumer,
  consumerReady
} = require('./orderConsumer');

const definition = loader.loadSync(
  path.join(__dirname, '../../../proto/shipment.proto'),
  {
    keepCase: true,
    defaults: true,
    oneofs: true
  }
);

const proto = grpc.loadPackageDefinition(definition).shipment;
const server = new grpc.Server();

let stopping = false;
let shutdownPromise;

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

function requireId(value, name) {
  if (!validId(value)) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      `${name} khong hop le`
    );
  }
}

function handler(work) {
  return async (call, callback) => {
    if (stopping) {
      return callback({
        code: grpc.status.UNAVAILABLE,
        details: 'Shipment Service dang dung'
      });
    }

    try {
      callback(null, await work(call.request));
    } catch (error) {
      console.error('Shipment error:', error.message);

      const isGrpcError =
        Number.isInteger(error.code) &&
        error.code >= 1 &&
        error.code <= 16;

      callback({
        code: isGrpcError ? error.code : grpc.status.INTERNAL,
        details: isGrpcError
          ? error.details || error.message
          : 'Khong the xu ly van don'
      });
    }
  };
}

async function findShipment(filter) {
  const shipment = await Shipment.findOne(filter);

  if (!shipment) {
    throw serviceError(
      grpc.status.NOT_FOUND,
      'Shipment khong ton tai'
    );
  }

  return serialize(shipment);
}

async function getShipment(request) {
  requireId(request.sid, 'SID');
  return findShipment({ sid: request.sid });
}

async function getShipmentByOrder(request) {
  requireId(request.oid, 'OID');
  return findShipment({ oid: request.oid });
}

async function listShipments(request) {
  // UID = 0 dung cho danh sach nghiep vu cua ADMIN/SHIPMENT_STAFF.
  // Gateway se kiem tra quyen truoc khi gui RPC.
  if (request.uid !== 0) {
    requireId(request.uid, 'UID');
  }

  const filter = request.uid === 0 ? {} : { uid: request.uid };

  const shipments = await Shipment.find(filter).sort({ sid: -1 });

  return {
    items: shipments.map(serialize)
  };
}

async function updateShipmentStatus(request) {
  requireId(request.sid, 'SID');

  const target = request.status;
  const allowedFrom = {
    IN_TRANSIT: ['PENDING'],
    DELIVERED: ['IN_TRANSIT'],
    CANCELLED: ['PENDING']
  };

  if (!Object.prototype.hasOwnProperty.call(allowedFrom, target)) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      'Trang thai cap nhat khong hop le'
    );
  }

  // Kiem tra trang thai cu va cap nhat trong cung thao tac.
  const shipment = await Shipment.findOneAndUpdate(
    {
      sid: request.sid,
      status: { $in: allowedFrom[target] }
    },
    { $set: { status: target } },
    {
      returnDocument: 'after',
      runValidators: true
    }
  );

  if (shipment) {
    return serialize(shipment);
  }

  const existing = await Shipment.findOne({ sid: request.sid });

  if (!existing) {
    throw serviceError(
      grpc.status.NOT_FOUND,
      'Shipment khong ton tai'
    );
  }

  // Gui lai cung trang thai khong lam thay doi van don.
  if (existing.status === target) {
    return serialize(existing);
  }

  throw serviceError(
    grpc.status.FAILED_PRECONDITION,
    `Khong the chuyen tu ${existing.status} sang ${target}`
  );
}

async function health() {
  await mongoose.connection.db.admin().ping();

  if (!consumerReady()) {
    throw serviceError(
      grpc.status.UNAVAILABLE,
      'Shipment Kafka consumer chua san sang'
    );
  }

  return { status: 'UP' };
}

server.addService(proto.ShipmentService.service, {
  GetShipment: handler(getShipment),
  GetShipmentByOrder: handler(getShipmentByOrder),
  ListShipments: handler(listShipments),
  UpdateShipmentStatus: handler(updateShipmentStatus),
  Health: handler(health)
});

async function stopResources() {
  stopping = true;
  console.log('Stopping Shipment Service...');

  // Dong RPC va consumer truoc khi dong MongoDB.
  const results = await Promise.allSettled([
    new Promise(resolve => server.tryShutdown(resolve)),
    stopConsumer()
  ]);

  await mongoose.disconnect();

  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

function shutdown() {
  shutdownPromise ||= stopResources();
  return shutdownPromise;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('Thieu MONGODB_URI');
  }

  const port = Number(process.env.GRPC_PORT || 50055);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('GRPC_PORT khong hop le');
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000
  });

  await initializeModels();
  console.log('Shipment DB connected');

  await startConsumer();

  const address =
    `${process.env.GRPC_HOST || '127.0.0.1'}:${port}`;

  await new Promise((resolve, reject) => {
    server.bindAsync(
      address,
      grpc.ServerCredentials.createInsecure(),
      error => error ? reject(error) : resolve()
    );
  });

  console.log(`Shipment gRPC running at ${address}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown().catch(error => {
      console.error('Shipment shutdown failed:', error.message);
      process.exitCode = 1;
    });
  });
}

main().catch(async error => {
  console.error('Shipment startup failed:', error.message);
  stopping = true;
  server.forceShutdown();

  try {
    await stopConsumer();
  } catch (stopError) {
    console.error(stopError.message);
  }

  await mongoose.disconnect();
  process.exitCode = 1;
});