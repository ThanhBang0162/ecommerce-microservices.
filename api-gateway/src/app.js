const path = require('node:path');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

const express = require('express');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const { createClient } = require('redis');

const setupCustomerRoutes = require('./customerRoutes');
const setupProductRoutes = require('./productRoutes');
const setupOrderRoutes = require('./orderRoutes');
const setupShipmentRoutes = require('./shipmentRoutes');

const definition = loader.loadSync(
  path.join(__dirname, '../../proto/auth.proto'),
  {
    keepCase: true,
    defaults: true,
    oneofs: true
  }
);

const authProto = grpc.loadPackageDefinition(definition).auth;

const authClient = new authProto.AuthService(
  process.env.AUTH_GRPC_ADDRESS || '127.0.0.1:50051',
  grpc.credentials.createInsecure()
);

const redis = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:16379',
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: false
  },
  disableOfflineQueue: true
});

redis.on('error', error => {
  console.error('Redis:', error.message);
});

function callGrpc(client, method, request) {
  return new Promise((resolve, reject) => {
    client[method](
      request,
      { deadline: new Date(Date.now() + 10000) },
      (error, response) => {
        if (error) return reject(error);
        resolve(response);
      }
    );
  });
}

function callAuth(method, request) {
  return callGrpc(authClient, method, request);
}

const app = express();
app.disable('x-powered-by');

// Ghi log request, khong ghi mat khau hoac token.
app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    console.log(
      `${req.method} ${req.path} ${res.statusCode} ` +
      `${Date.now() - startedAt}ms`
    );
  });

  next();
});

// Gioi han 60 request moi phut tren moi IP.
app.use(async (req, res, next) => {
  if (req.path === '/api/health') {
    return next();
  }

  try {
    const window = Math.floor(Date.now() / 60000);
    const key = `rate:${req.ip}:${window}`;

    const count = Number(
      await redis.eval(
        `local count = redis.call('INCR', KEYS[1])
         if count == 1 then
           redis.call('EXPIRE', KEYS[1], 60)
         end
         return count`,
        {
          keys: [key],
          arguments: []
        }
      )
    );

    if (count > 60) {
      const retryAfter =
        60 - (Math.floor(Date.now() / 1000) % 60);

      res.set('Retry-After', String(retryAfter));

      return res.status(429).json({
        message: 'Qua nhieu request, vui long thu lai sau'
      });
    }

    next();
  } catch (error) {
    next(error);
  }
});

app.use(express.json({ limit: '32kb' }));

async function authenticate(req, res, next) {
  const authorization = req.get('Authorization') || '';
  const match = authorization.match(/^Bearer ([^\s]+)$/i);

  if (!match) {
    return res.status(401).json({
      message: 'Can cung cap Bearer token'
    });
  }

  try {
    req.user = await callAuth('VerifyToken', {
      token: match[1]
    });

    next();
  } catch (error) {
    next(error);
  }
}

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const body = req.body || {};

    if (
      typeof body.username !== 'string' ||
      typeof body.password !== 'string' ||
      (
        body.email !== undefined &&
        typeof body.email !== 'string'
      ) ||
      (
        body.phone !== undefined &&
        typeof body.phone !== 'string'
      )
    ) {
      return res.status(400).json({
        message: 'Du lieu dang ky khong hop le'
      });
    }

    const result = await callAuth('Register', {
      username: body.username,
      password: body.password,
      email: body.email || '',
      phone: body.phone || ''
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const body = req.body || {};

    if (
      typeof body.username !== 'string' ||
      typeof body.password !== 'string'
    ) {
      return res.status(400).json({
        message: 'Can nhap username va password'
      });
    }

    const result = await callAuth('Login', {
      username: body.username,
      password: body.password
    });

    res.json({
      accessToken: result.access_token,
      tokenType: result.token_type,
      expiresIn: result.expires_in
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({
    uid: req.user.uid,
    role: req.user.role
  });
});

// Product routes nhan Redis de cache danh sach san pham.
const customerClient = setupCustomerRoutes(app, authenticate);
const productClient = setupProductRoutes(app, authenticate, redis);
const orderClient = setupOrderRoutes(app, authenticate);
const shipmentClient = setupShipmentRoutes(app, authenticate);

app.get('/api/health', async (req, res) => {
  const checks = await Promise.allSettled([
    callAuth('Health', {}),
    callGrpc(customerClient, 'Health', {}),
    callGrpc(productClient, 'Health', {}),
    callGrpc(orderClient, 'Health', {}),
    callGrpc(shipmentClient, 'Health', {}),
    redis.ping()
  ]);

  const names = [
    'auth',
    'customer',
    'product',
    'order',
    'shipment',
    'redis'
  ];

  const services = {};

  checks.forEach((result, index) => {
    const healthy =
      result.status === 'fulfilled' &&
      (
        names[index] === 'redis'
          ? result.value === 'PONG'
          : result.value.status === 'UP'
      );

    services[names[index]] = healthy ? 'UP' : 'DOWN';
  });

  const healthy = Object.values(services).every(
    status => status === 'UP'
  );

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'UP' : 'DOWN',
    services
  });
});

app.use((req, res) => {
  res.status(404).json({
    message: 'API khong ton tai'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      message: 'JSON khong hop le'
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      message: 'Request qua lon'
    });
  }

  const statusMap = {
    [grpc.status.INVALID_ARGUMENT]: 400,
    [grpc.status.UNAUTHENTICATED]: 401,
    [grpc.status.PERMISSION_DENIED]: 403,
    [grpc.status.NOT_FOUND]: 404,
    [grpc.status.ALREADY_EXISTS]: 409,
    [grpc.status.FAILED_PRECONDITION]: 409,
    [grpc.status.ABORTED]: 409,
    [grpc.status.RESOURCE_EXHAUSTED]: 429,
    [grpc.status.INTERNAL]: 500,
    [grpc.status.UNAVAILABLE]: 503,
    [grpc.status.DEADLINE_EXCEEDED]: 504
  };

  const status = statusMap[error.code] || 503;

  console.error('Request failed:', error.message);

  res.status(status).json({
    message:
      status < 500
        ? error.details || 'Request khong hop le'
        : 'Dich vu chua san sang'
  });
});

let httpServer;
let shuttingDown = false;

function closeClients() {
  authClient.close();
  customerClient.close();
  productClient.close();
  orderClient.close();
  shipmentClient.close();

  if (redis.isOpen) {
    redis.destroy();
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Stopping API Gateway...');

  const forceExit = setTimeout(() => {
    process.exit(1);
  }, 10000);

  forceExit.unref();

  if (httpServer) {
    await new Promise(resolve => {
      httpServer.close(resolve);
    });
  }

  closeClients();
  clearTimeout(forceExit);
}

async function main() {
  const port = Number(process.env.PORT || 3002);
  const host = process.env.HOST || '127.0.0.1';

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('PORT khong hop le');
  }

  await redis.connect();
  console.log('Redis connected');

  await new Promise((resolve, reject) => {
    httpServer = app.listen(port, host);
    httpServer.once('error', reject);
    httpServer.once('listening', resolve);
  });

  console.log(
    `API Gateway running at http://${host}:${port}`
  );
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown().catch(error => {
      console.error('Shutdown failed:', error.message);
      process.exitCode = 1;
    });
  });
}

main().catch(error => {
  console.error('Gateway startup failed:', error.message);
  closeClients();
  process.exitCode = 1;
});