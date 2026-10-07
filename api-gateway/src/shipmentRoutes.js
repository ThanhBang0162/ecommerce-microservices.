const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

module.exports = function setupShipmentRoutes(app, authenticate) {
  const definition = loader.loadSync(
    path.join(__dirname, '../../proto/shipment.proto'),
    {
      keepCase: true,
      defaults: true,
      oneofs: true
    }
  );

  const proto = grpc.loadPackageDefinition(definition).shipment;

  const client = new proto.ShipmentService(
    process.env.SHIPMENT_GRPC_ADDRESS || '127.0.0.1:50055',
    grpc.credentials.createInsecure()
  );

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

  function parseId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
      return null;
    }

    const number = Number(value);

    return Number.isInteger(number) && number <= 2147483647
      ? number
      : null;
  }

  function isStaff(user) {
    return ['ADMIN', 'SHIPMENT_STAFF'].includes(user.role);
  }

  function canRead(user, shipment) {
    return isStaff(user) || shipment.uid === user.uid;
  }

  // CUSTOMER xem cua minh; nhan vien xem tat ca hoac loc theo UID.
  app.get('/api/shipments', authenticate, async (req, res, next) => {
    try {
      let uid = isStaff(req.user) ? 0 : req.user.uid;

      if (req.query.uid !== undefined) {
        const requestedUid = parseId(req.query.uid);

        if (!requestedUid) {
          return res.status(400).json({
            message: 'UID khong hop le'
          });
        }

        if (!isStaff(req.user) && requestedUid !== req.user.uid) {
          return res.status(403).json({
            message: 'Khong duoc xem van don cua nguoi khac'
          });
        }

        uid = requestedUid;
      }

      res.json(await invoke('ListShipments', { uid }));
    } catch (error) {
      next(error);
    }
  });

  app.get(
    '/api/orders/:oid/shipment',
    authenticate,
    async (req, res, next) => {
      try {
        const oid = parseId(req.params.oid);

        if (!oid) {
          return res.status(400).json({
            message: 'OID khong hop le'
          });
        }

        const shipment = await invoke('GetShipmentByOrder', { oid });

        if (!canRead(req.user, shipment)) {
          return res.status(403).json({
            message: 'Khong duoc xem van don cua nguoi khac'
          });
        }

        res.json(shipment);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get('/api/shipments/:sid', authenticate, async (req, res, next) => {
    try {
      const sid = parseId(req.params.sid);

      if (!sid) {
        return res.status(400).json({
          message: 'SID khong hop le'
        });
      }

      const shipment = await invoke('GetShipment', { sid });

      if (!canRead(req.user, shipment)) {
        return res.status(403).json({
          message: 'Khong duoc xem van don cua nguoi khac'
        });
      }

      res.json(shipment);
    } catch (error) {
      next(error);
    }
  });

  app.patch(
    '/api/shipments/:sid/status',
    authenticate,
    async (req, res, next) => {
      try {
        if (!isStaff(req.user)) {
          return res.status(403).json({
            message: 'Chi ADMIN hoac SHIPMENT_STAFF duoc cap nhat van don'
          });
        }

        const sid = parseId(req.params.sid);

        if (!sid) {
          return res.status(400).json({
            message: 'SID khong hop le'
          });
        }

        const status = req.body?.status;

        if (!['IN_TRANSIT', 'DELIVERED', 'CANCELLED'].includes(status)) {
          return res.status(400).json({
            message: 'Trang thai khong hop le'
          });
        }

        res.json(await invoke('UpdateShipmentStatus', {
          sid,
          status
        }));
      } catch (error) {
        next(error);
      }
    }
  );

  return client;
};