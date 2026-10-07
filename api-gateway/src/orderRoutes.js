const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

module.exports = function setupOrderRoutes(app, authenticate) {
  const definition = loader.loadSync(
    path.join(__dirname, '../../proto/order.proto'),
    {
      keepCase: true,
      defaults: true,
      oneofs: true
    }
  );

  const proto = grpc.loadPackageDefinition(definition).order;

  const client = new proto.OrderService(
    process.env.ORDER_GRPC_ADDRESS || '127.0.0.1:50054',
    grpc.credentials.createInsecure()
  );

  function invoke(method, request) {
    return new Promise((resolve, reject) => {
      client[method](
        request,
        { deadline: new Date(Date.now() + 60000) },
        (error, response) => {
          if (error) return reject(error);
          resolve(response);
        }
      );
    });
  }

  function validId(value) {
    return Number.isInteger(value) &&
      value > 0 &&
      value <= 2147483647;
  }

  function parseId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
      return null;
    }

    const number = Number(value);
    return validId(number) ? number : null;
  }

  // Tao don cho nguoi dung dang dang nhap.
  app.post('/api/orders', authenticate, async (req, res, next) => {
    try {
      const requestId = req.get('Idempotency-Key') || '';

      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          .test(requestId)
      ) {
        return res.status(400).json({
          message: 'Can cung cap header Idempotency-Key la UUID'
        });
      }

      res.set('Idempotency-Key', requestId.toLowerCase());

      const items = req.body?.items;

      if (
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > 50
      ) {
        return res.status(400).json({
          message: 'Don hang can tu 1 den 50 san pham'
        });
      }

      const seen = new Set();

      for (const item of items) {
        if (
          !item ||
          !validId(item.pid) ||
          !validId(item.qty) ||
          seen.has(item.pid)
        ) {
          return res.status(400).json({
            message: 'PID, so luong khong hop le hoac PID bi lap'
          });
        }

        seen.add(item.pid);
      }

      const order = await invoke('CreateOrder', {
        request_id: requestId.toLowerCase(),
        uid: req.user.uid,
        items: items.map(item => ({
          pid: item.pid,
          qty: item.qty
        }))
      });

      res.status(201).json(order);
    } catch (error) {
      next(error);
    }
  });

  // Khach xem don cua minh; ADMIN co the chi dinh uid.
  app.get('/api/orders', authenticate, async (req, res, next) => {
    try {
      let uid = req.user.uid;

      if (req.query.uid !== undefined) {
        const requestedUid = parseId(req.query.uid);

        if (!requestedUid) {
          return res.status(400).json({
            message: 'UID khong hop le'
          });
        }

        if (
          req.user.role !== 'ADMIN' &&
          requestedUid !== req.user.uid
        ) {
          return res.status(403).json({
            message: 'Khong duoc xem don hang cua nguoi khac'
          });
        }

        uid = requestedUid;
      }

      res.json(await invoke('ListOrders', { uid }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/orders/:oid', authenticate, async (req, res, next) => {
    try {
      const oid = parseId(req.params.oid);

      if (!oid) {
        return res.status(400).json({
          message: 'OID khong hop le'
        });
      }

      const order = await invoke('GetOrder', { oid });

      if (
        req.user.role !== 'ADMIN' &&
        order.uid !== req.user.uid
      ) {
        return res.status(403).json({
          message: 'Khong duoc xem don hang cua nguoi khac'
        });
      }

      res.json(order);
    } catch (error) {
      next(error);
    }
  });

  return client;
};