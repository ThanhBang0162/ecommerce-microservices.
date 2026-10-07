const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

module.exports = function setupProductRoutes(app, authenticate, redis) {
  const definition = loader.loadSync(
    path.join(__dirname, '../../proto/product.proto'),
    { keepCase: true, defaults: true, oneofs: true }
  );

  const proto = grpc.loadPackageDefinition(definition).product;

  const client = new proto.ProductService(
    process.env.PRODUCT_GRPC_ADDRESS || '127.0.0.1:50053',
    grpc.credentials.createInsecure()
  );

  const cacheVersionKey = 'cache:products:version';
  const cacheTtl = 5;

  function invoke(method, request) {
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

  async function invalidateCache() {
    try {
      await redis.incr(cacheVersionKey);
    } catch (error) {
      console.error('Product cache invalidation failed:', error.message);
    }
  }

  function adminOnly(req, res, next) {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        message: 'Chi ADMIN duoc quan ly san pham'
      });
    }

    next();
  }

  function validatePid(req, res, next) {
    const value = req.params.pid;
    const pid = Number(value);

    if (
      !/^[1-9]\d*$/.test(value) ||
      !Number.isInteger(pid) ||
      pid > 2147483647
    ) {
      return res.status(400).json({
        message: 'PID khong hop le'
      });
    }

    req.productPid = pid;
    next();
  }

  function parseBody(body, creating) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const request = {};
    const has = field =>
      Object.prototype.hasOwnProperty.call(body, field);

    if (creating || has('pname')) {
      if (
        typeof body.pname !== 'string' ||
        !body.pname.trim() ||
        body.pname.trim().length > 100
      ) {
        return null;
      }

      request.pname = body.pname.trim();
    }

    if (creating || has('price')) {
      if (
        typeof body.price !== 'string' &&
        typeof body.price !== 'number'
      ) {
        return null;
      }

      const price = String(body.price);

      if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(price)) {
        return null;
      }

      request.price = price;
    }

    if (creating || has('quantity')) {
      if (
        !Number.isInteger(body.quantity) ||
        body.quantity < 0 ||
        body.quantity > 2147483647
      ) {
        return null;
      }

      request.quantity = body.quantity;
    }

    return Object.keys(request).length ? request : null;
  }

  app.get('/api/products', authenticate, async (req, res, next) => {
    let cacheKey;

    try {
      try {
        const version = await redis.get(cacheVersionKey) || '0';
        cacheKey = `cache:products:list:${version}`;

        const cached = await redis.get(cacheKey);

        if (cached) {
          const data = JSON.parse(cached);

          if (data && Array.isArray(data.items)) {
            res.set('X-Cache', 'HIT');
            res.set('Cache-Control', 'no-store');
            return res.json(data);
          }
        }
      } catch (error) {
        console.error('Product cache read failed:', error.message);
        cacheKey = undefined;
      }

      const result = await invoke('ListProducts', {});

      if (cacheKey) {
        try {
          await redis.set(cacheKey, JSON.stringify(result), {
            EX: cacheTtl
          });
        } catch (error) {
          console.error('Product cache write failed:', error.message);
        }
      }

      res.set('X-Cache', 'MISS');
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // Chi tiet san pham doc truc tiep tu Product Service.
  app.get(
    '/api/products/:pid',
    authenticate,
    validatePid,
    async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');

        res.json(await invoke('GetProduct', {
          pid: req.productPid
        }));
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    '/api/products',
    authenticate,
    adminOnly,
    async (req, res, next) => {
      const request = parseBody(req.body, true);

      if (!request) {
        return res.status(400).json({
          message: 'Du lieu san pham khong hop le'
        });
      }

      try {
        let result;

        try {
          result = await invoke('CreateProduct', request);
        } finally {
          // RPC timeout cung co the da thay doi du lieu.
          await invalidateCache();
        }

        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.put(
    '/api/products/:pid',
    authenticate,
    adminOnly,
    validatePid,
    async (req, res, next) => {
      const request = parseBody(req.body, false);

      if (!request) {
        return res.status(400).json({
          message: 'Du lieu cap nhat khong hop le'
        });
      }

      try {
        let result;

        try {
          result = await invoke('UpdateProduct', {
            ...request,
            pid: req.productPid
          });
        } finally {
          await invalidateCache();
        }

        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete(
    '/api/products/:pid',
    authenticate,
    adminOnly,
    validatePid,
    async (req, res, next) => {
      try {
        let result;

        try {
          result = await invoke('DeleteProduct', {
            pid: req.productPid
          });
        } finally {
          await invalidateCache();
        }

        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  return client;
};