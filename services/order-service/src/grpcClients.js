const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

function createClient(filename, packageName, serviceName, address) {
  if (!address) {
    throw new Error(`Thieu dia chi ${serviceName}`);
  }

  const definition = loader.loadSync(
    path.join(__dirname, '../../../proto', filename),
    {
      keepCase: true,
      defaults: true,
      oneofs: true
    }
  );

  const proto = grpc.loadPackageDefinition(definition);

  return new proto[packageName][serviceName](
    address,
    grpc.credentials.createInsecure()
  );
}

const customerClient = createClient(
  'customer.proto',
  'customer',
  'CustomerService',
  process.env.CUSTOMER_GRPC_ADDRESS
);

const productClient = createClient(
  'product.proto',
  'product',
  'ProductService',
  process.env.PRODUCT_GRPC_ADDRESS
);

function invoke(client, method, request) {
  return new Promise((resolve, reject) => {
    client[method](
      request,
      { deadline: new Date(Date.now() + 5000) },
      (error, response) => {
        if (error) return reject(error);
        resolve(response);
      }
    );
  });
}

function getCustomer(uid) {
  return invoke(customerClient, 'GetCustomer', { uid });
}

function reserveStock(reservationId, pid, qty) {
  return invoke(productClient, 'ReserveStock', {
    reservation_id: reservationId,
    pid,
    qty
  });
}

function releaseStock(reservationId, pid) {
  return invoke(productClient, 'ReleaseStock', {
    reservation_id: reservationId,
    pid
  });
}

async function checkDependencies() {
  const results = await Promise.all([
    invoke(customerClient, 'Health', {}),
    invoke(productClient, 'Health', {})
  ]);

  if (results.some(result => result.status !== 'UP')) {
    const error = new Error('Customer hoac Product chua san sang');
    error.code = grpc.status.UNAVAILABLE;
    throw error;
  }
}

function closeClients() {
  customerClient.close();
  productClient.close();
}

module.exports = {
  getCustomer,
  reserveStock,
  releaseStock,
  checkDependencies,
  closeClients
};