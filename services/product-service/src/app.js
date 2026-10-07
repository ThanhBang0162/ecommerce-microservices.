const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const mongoose = require('mongoose');

if (!process.env.MONGODB_URI) {
  console.error('Thieu MONGODB_URI');
  process.exit(1);
}

const definition = loader.loadSync(
  path.join(__dirname, '../../../proto/product.proto'),
  { keepCase: true, defaults: true, oneofs: true }
);

const proto = grpc.loadPackageDefinition(definition).product;

// Luu lich su giu hang de xu ly yeu cau gui lai.
const reservationSchema = new mongoose.Schema({
  reservation_id: { type: String, required: true },
  qty: { type: Number, required: true },
  unit_price: { type: String, required: true },
  state: {
    type: String,
    enum: ['RESERVED', 'RELEASED'],
    required: true
  }
}, { _id: false });

const productSchema = new mongoose.Schema({
  pid: { type: Number, required: true, unique: true },
  pname: { type: String, required: true, maxlength: 100 },
  price: {
    type: mongoose.Schema.Types.Decimal128,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 0,
    max: 2147483647
  },
  reservations: {
    type: [reservationSchema],
    default: []
  }
});

const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 }
});

const Product = mongoose.model('Product', productSchema);
const Counter = mongoose.model('Counter', counterSchema);
const server = new grpc.Server();

function fail(callback, code, details) {
  callback({ code, details });
}

function validId(value) {
  return Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647;
}

function validQuantity(value) {
  return Number.isInteger(value) &&
    value >= 0 &&
    value <= 2147483647;
}

function validPrice(value) {
  return typeof value === 'string' &&
    /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(value);
}

function validReservation(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(value);
}

function serialize(product) {
  return {
    pid: product.pid,
    pname: product.pname,
    price: product.price.toString(),
    quantity: product.quantity
  };
}

function databaseError(error, callback) {
  console.error('Product error:', error.message);
  fail(
    callback,
    grpc.status.INTERNAL,
    'Khong the xu ly du lieu san pham'
  );
}

async function listProducts(call, callback) {
  try {
    const products = await Product.find().sort({ pid: 1 });
    callback(null, { items: products.map(serialize) });
  } catch (error) {
    databaseError(error, callback);
  }
}

async function getProduct(call, callback) {
  const { pid } = call.request;

  if (!validId(pid)) {
    return fail(callback, grpc.status.INVALID_ARGUMENT, 'PID khong hop le');
  }

  try {
    const product = await Product.findOne({ pid });

    if (!product) {
      return fail(callback, grpc.status.NOT_FOUND, 'Product khong ton tai');
    }

    callback(null, serialize(product));
  } catch (error) {
    databaseError(error, callback);
  }
}

async function createProduct(call, callback) {
  const pname = (call.request.pname || '').trim();
  const { price, quantity } = call.request;

  if (
    !pname ||
    pname.length > 100 ||
    !validPrice(price) ||
    !validQuantity(quantity)
  ) {
    return fail(
      callback,
      grpc.status.INVALID_ARGUMENT,
      'Ten, gia hoac so luong khong hop le'
    );
  }

  try {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'product' },
      { $inc: { seq: 1 } },
      { returnDocument: 'after' }
    );

    if (!counter || !validId(counter.seq)) {
      throw new Error('Product counter unavailable');
    }

    const product = await Product.create({
      pid: counter.seq,
      pname,
      price,
      quantity
    });

    callback(null, serialize(product));
  } catch (error) {
    databaseError(error, callback);
  }
}

async function updateProduct(call, callback) {
  const request = call.request;
  const has = field =>
    Object.prototype.hasOwnProperty.call(request, field);

  if (!validId(request.pid)) {
    return fail(callback, grpc.status.INVALID_ARGUMENT, 'PID khong hop le');
  }

  const updates = {};

  if (has('pname')) {
    const pname = request.pname.trim();

    if (!pname || pname.length > 100) {
      return fail(
        callback,
        grpc.status.INVALID_ARGUMENT,
        'Ten san pham khong hop le'
      );
    }

    updates.pname = pname;
  }

  if (has('price')) {
    if (!validPrice(request.price)) {
      return fail(callback, grpc.status.INVALID_ARGUMENT, 'Gia khong hop le');
    }

    updates.price = request.price;
  }

  if (has('quantity')) {
    if (!validQuantity(request.quantity)) {
      return fail(
        callback,
        grpc.status.INVALID_ARGUMENT,
        'So luong khong hop le'
      );
    }

    updates.quantity = request.quantity;
  }

  if (!Object.keys(updates).length) {
    return fail(
      callback,
      grpc.status.INVALID_ARGUMENT,
      'Can gui it nhat mot truong cap nhat'
    );
  }

  try {
    const filter = { pid: request.pid };

    // Khong ghi de so luong trong khi co hang dang duoc giu.
    if (has('quantity')) {
      filter.reservations = {
        $not: { $elemMatch: { state: 'RESERVED' } }
      };
    }

    const product = await Product.findOneAndUpdate(
      filter,
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    );

    if (!product) {
      const exists = await Product.exists({ pid: request.pid });

      return fail(
        callback,
        exists ? grpc.status.FAILED_PRECONDITION : grpc.status.NOT_FOUND,
        exists
          ? 'Khong the sua so luong khi san pham dang duoc giu'
          : 'Product khong ton tai'
      );
    }

    callback(null, serialize(product));
  } catch (error) {
    databaseError(error, callback);
  }
}

async function deleteProduct(call, callback) {
  const { pid } = call.request;

  if (!validId(pid)) {
    return fail(callback, grpc.status.INVALID_ARGUMENT, 'PID khong hop le');
  }

  try {
    // Giu lich su de cac yeu cau thu lai van xu ly dung.
    const product = await Product.findOneAndDelete({
      pid,
      'reservations.0': { $exists: false }
    });

    if (!product) {
      const exists = await Product.exists({ pid });

      return fail(
        callback,
        exists ? grpc.status.FAILED_PRECONDITION : grpc.status.NOT_FOUND,
        exists
          ? 'Khong the xoa san pham da co lich su giu hang'
          : 'Product khong ton tai'
      );
    }

    callback(null, {
      pid,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    databaseError(error, callback);
  }
}

async function reserveStock(call, callback) {
  const { pid, qty, reservation_id } = call.request;

  if (
    !validId(pid) ||
    !validId(qty) ||
    !validReservation(reservation_id)
  ) {
    return fail(
      callback,
      grpc.status.INVALID_ARGUMENT,
      'PID, so luong hoac ma giu hang khong hop le'
    );
  }

  try {
    // Dung collection truc tiep cho MongoDB update pipeline.
    // Kiem tra kho, tru kho va luu gia cung mot cap nhat nguyen tu.
    await Product.collection.updateOne(
      {
        pid,
        quantity: { $gte: qty },
        'reservations.reservation_id': { $ne: reservation_id }
      },
      [
        {
          $set: {
            quantity: { $subtract: ['$quantity', qty] },
            reservations: {
              $concatArrays: [
                { $ifNull: ['$reservations', []] },
                [
                  {
                    reservation_id: { $literal: reservation_id },
                    qty: { $literal: qty },
                    unit_price: { $toString: '$price' },
                    state: { $literal: 'RESERVED' }
                  }
                ]
              ]
            }
          }
        }
      ]
    );

    const product = await Product.findOne({ pid });

    if (!product) {
      return fail(callback, grpc.status.NOT_FOUND, 'Product khong ton tai');
    }

    const reservation = product.reservations.find(
      item => item.reservation_id === reservation_id
    );

    if (!reservation) {
      return fail(
        callback,
        grpc.status.FAILED_PRECONDITION,
        'San pham khong du so luong'
      );
    }

    if (reservation.state === 'RELEASED') {
      return fail(
        callback,
        grpc.status.FAILED_PRECONDITION,
        'Ma giu hang da duoc huy'
      );
    }

    if (reservation.qty !== qty) {
      return fail(
        callback,
        grpc.status.INVALID_ARGUMENT,
        'Ma giu hang da duoc dung voi so luong khac'
      );
    }

    callback(null, {
      reservation_id,
      pid,
      qty: reservation.qty,
      unit_price: reservation.unit_price
    });
  } catch (error) {
    databaseError(error, callback);
  }
}

async function releaseStock(call, callback) {
  const { pid, reservation_id } = call.request;

  if (!validId(pid) || !validReservation(reservation_id)) {
    return fail(
      callback,
      grpc.status.INVALID_ARGUMENT,
      'PID hoac ma giu hang khong hop le'
    );
  }

  try {
    const reservations = { $ifNull: ['$reservations', []] };
    const matches = {
      $filter: {
        input: reservations,
        as: 'item',
        cond: {
          $eq: ['$$item.reservation_id', reservation_id]
        }
      }
    };

    // Hoan kho va danh dau RELEASED cung mot cap nhat nguyen tu.
    // Neu lenh huy den truoc lenh giu, luu dau huy de chan lenh giu muon.
    const result = await Product.collection.updateOne(
      { pid },
      [
        {
          $set: {
            quantity: {
              $add: [
                '$quantity',
                {
                  $reduce: {
                    input: matches,
                    initialValue: 0,
                    in: {
                      $add: [
                        '$$value',
                        {
                          $cond: [
                            { $eq: ['$$this.state', 'RESERVED'] },
                            '$$this.qty',
                            0
                          ]
                        }
                      ]
                    }
                  }
                }
              ]
            },
            reservations: {
              $cond: [
                { $gt: [{ $size: matches }, 0] },
                {
                  $map: {
                    input: reservations,
                    as: 'item',
                    in: {
                      $cond: [
                        {
                          $eq: ['$$item.reservation_id', reservation_id]
                        },
                        {
                          $mergeObjects: [
                            '$$item',
                            { state: 'RELEASED' }
                          ]
                        },
                        '$$item'
                      ]
                    }
                  }
                },
                {
                  $concatArrays: [
                    reservations,
                    {
                      $literal: [
                        {
                          reservation_id,
                          qty: 0,
                          unit_price: '0',
                          state: 'RELEASED'
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          }
        }
      ]
    );

    if (!result.matchedCount) {
      return fail(callback, grpc.status.NOT_FOUND, 'Product khong ton tai');
    }

    callback(null, {
      reservation_id,
      pid,
      released: true
    });
  } catch (error) {
    databaseError(error, callback);
  }
}

async function health(call, callback) {
  try {
    await mongoose.connection.db.admin().ping();
    callback(null, { status: 'UP' });
  } catch (error) {
    fail(
      callback,
      grpc.status.UNAVAILABLE,
      'Product database unavailable'
    );
  }
}

server.addService(proto.ProductService.service, {
  ListProducts: listProducts,
  GetProduct: getProduct,
  CreateProduct: createProduct,
  UpdateProduct: updateProduct,
  DeleteProduct: deleteProduct,
  ReserveStock: reserveStock,
  ReleaseStock: releaseStock,
  Health: health
});

let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;

  console.log('Stopping Product Service...');

  const timer = setTimeout(() => server.forceShutdown(), 5000);
  timer.unref();

  await new Promise(resolve => server.tryShutdown(resolve));

  clearTimeout(timer);
  await mongoose.disconnect();
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000
  });

  await Product.init();

  await Counter.updateOne(
    { _id: 'product' },
    { $setOnInsert: { seq: 0 } },
    { upsert: true }
  );

  console.log('Product DB connected');

  const address =
    `${process.env.GRPC_HOST || '127.0.0.1'}:` +
    `${process.env.GRPC_PORT || '50053'}`;

  await new Promise((resolve, reject) => {
    server.bindAsync(
      address,
      grpc.ServerCredentials.createInsecure(),
      error => error ? reject(error) : resolve()
    );
  });

  console.log(`Product gRPC running at ${address}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown().catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  });
}

main().catch(async error => {
  console.error('Product startup failed:', error.message);
  server.forceShutdown();
  await mongoose.disconnect();
  process.exitCode = 1;
});