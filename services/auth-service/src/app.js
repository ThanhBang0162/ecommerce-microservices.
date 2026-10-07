const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { Pool } = require('pg');
const createAuthHandlers = require('./authHandlers');

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  console.error('Thieu DATABASE_URL hoac JWT_SECRET');
  process.exit(1);
}

const definition = protoLoader.loadSync(
  path.join(__dirname, '../../../proto/auth.proto'),
  {
    keepCase: true,
    defaults: true,
    oneofs: true
  }
);

const authProto = grpc.loadPackageDefinition(definition).auth;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000
});

const server = new grpc.Server();
const authHandlers = createAuthHandlers(pool);

function notImplemented(call, callback) {
  callback({
    code: grpc.status.UNIMPLEMENTED,
    details: 'Chuc nang se duoc bo sung o buoc tiep theo'
  });
}

async function health(call, callback) {
  try {
    await pool.query('SELECT 1');
    callback(null, { status: 'UP' });
  } catch (error) {
    console.error('Health check:', error.message);

    callback({
      code: grpc.status.UNAVAILABLE,
      details: 'Auth database unavailable'
    });
  }
}

server.addService(authProto.AuthService.service, {
  Register: authHandlers.register,
  Login: authHandlers.login,
  VerifyToken: authHandlers.verifyToken,
  Health: health
});

async function main() {
  await pool.query('SELECT 1');
  console.log('Auth DB connected');

  const host = process.env.GRPC_HOST || '127.0.0.1';
  const port = process.env.GRPC_PORT || '50051';
  const address = `${host}:${port}`;

  await new Promise((resolve, reject) => {
    server.bindAsync(
      address,
      grpc.ServerCredentials.createInsecure(),
      (error) => {
        if (error) {
          return reject(error);
        }

        resolve();
      }
    );
  });

  console.log(`Auth gRPC running at ${address}`);
}

main().catch(async (error) => {
  console.error('Auth startup failed:', error.message);
  server.forceShutdown();
  await pool.end();
  process.exitCode = 1;
});