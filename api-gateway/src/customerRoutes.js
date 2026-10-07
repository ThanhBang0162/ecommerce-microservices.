const path = require('path');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

module.exports = function setupCustomerRoutes(app, authenticate) {
  const definition = loader.loadSync(
    path.join(__dirname, '../../proto/customer.proto'),
    { keepCase: true, defaults: true, oneofs: true }
  );

  const proto = grpc.loadPackageDefinition(definition).customer;

  const client = new proto.CustomerService(
    process.env.CUSTOMER_GRPC_ADDRESS || '127.0.0.1:50052',
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

  function authorizeCustomer(req, res, next) {
    const value = req.params.uid;

    if (!/^[1-9]\d*$/.test(value)) {
      return res.status(400).json({
        message: 'UID khong hop le'
      });
    }

    const uid = Number(value);

    if (!Number.isSafeInteger(uid) || uid > 2147483647) {
      return res.status(400).json({
        message: 'UID khong hop le'
      });
    }

    if (req.user.uid !== uid && req.user.role !== 'ADMIN') {
      return res.status(403).json({
        message: 'Ban khong co quyen truy cap Customer nay'
      });
    }

    req.customerUid = uid;
    next();
  }

  app.get(
    '/api/customers/:uid',
    authenticate,
    authorizeCustomer,
    async (req, res, next) => {
      try {
        const customer = await invoke('GetCustomer', {
          uid: req.customerUid
        });

        res.json(customer);
      } catch (error) {
        next(error);
      }
    }
  );

  app.put(
    '/api/customers/:uid',
    authenticate,
    authorizeCustomer,
    async (req, res, next) => {
      try {
        const body = req.body || {};
        const hasMid = Object.prototype.hasOwnProperty.call(body, 'mid');

        if (
          typeof body.fullname !== 'string' ||
          !body.fullname.trim() ||
          body.fullname.trim().length > 100
        ) {
          return res.status(400).json({
            message: 'Fullname khong hop le'
          });
        }

        if (hasMid && req.user.role !== 'ADMIN') {
          return res.status(403).json({
            message: 'Chi ADMIN duoc thay doi hang thanh vien'
          });
        }

        if (
          hasMid &&
          (
            !Number.isInteger(body.mid) ||
            body.mid <= 0 ||
            body.mid > 2147483647
          )
        ) {
          return res.status(400).json({
            message: 'MID khong hop le'
          });
        }

        const request = {
          uid: req.customerUid,
          fullname: body.fullname.trim()
        };

        if (hasMid) request.mid = body.mid;

        res.json(await invoke('UpdateCustomer', request));
      } catch (error) {
        next(error);
      }
    }
  );

  return client;
};