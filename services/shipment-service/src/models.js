const mongoose = require('mongoose');

const shipmentSchema = new mongoose.Schema({
  sid: {
    type: Number,
    required: true,
    unique: true,
    min: 1,
    max: 2147483647
  },
  oid: {
    type: Number,
    required: true,
    unique: true,
    min: 1,
    max: 2147483647
  },
  uid: {
    type: Number,
    required: true,
    min: 1,
    max: 2147483647
  },
  event_id: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    required: true,
    enum: [
      'PENDING',
      'IN_TRANSIT',
      'DELIVERED',
      'CANCELLED'
    ],
    default: 'PENDING'
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

const counterSchema = new mongoose.Schema({
  _id: {
    type: String,
    required: true
  },
  seq: {
    type: Number,
    default: 0
  }
});

const Shipment = mongoose.model('Shipment', shipmentSchema);
const Counter = mongoose.model('Counter', counterSchema);

async function initializeModels() {
  await Shipment.init();
  await Counter.init();

  await Counter.updateOne(
    { _id: 'shipment' },
    { $setOnInsert: { seq: 0 } },
    { upsert: true }
  );
}

function serialize(shipment) {
  return {
    sid: shipment.sid,
    oid: shipment.oid,
    uid: shipment.uid,
    status: shipment.status,
    created_at: shipment.created_at.toISOString(),
    updated_at: shipment.updated_at.toISOString()
  };
}

module.exports = {
  Shipment,
  Counter,
  initializeModels,
  serialize
};