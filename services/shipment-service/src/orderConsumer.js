const { Kafka } = require('kafkajs');
const { Shipment, Counter } = require('./models');

let consumer;
let ready = false;

function validId(value) {
  return Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647;
}

function validateEvent(event) {
  if (
    !event ||
    event.event_type !== 'OrderCreated' ||
    !validId(event.oid) ||
    !validId(event.uid) ||
    typeof event.event_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(event.event_id)
  ) {
    throw new Error('Su kien OrderCreated khong hop le');
  }
}

function checkExisting(shipment, event) {
  if (
    shipment.oid !== event.oid ||
    shipment.uid !== event.uid ||
    shipment.event_id !== event.event_id
  ) {
    throw new Error('Su kien xung dot voi van don da ton tai');
  }
}

async function createFromEvent(event) {
  validateEvent(event);

  const existing = await Shipment.findOne({
    $or: [
      { oid: event.oid },
      { event_id: event.event_id }
    ]
  });

  if (existing) {
    checkExisting(existing, event);
    console.log('Bo qua su kien da xu ly:', event.event_id);
    return existing;
  }

  const counter = await Counter.findOneAndUpdate(
    { _id: 'shipment' },
    { $inc: { seq: 1 } },
    { returnDocument: 'after' }
  );

  if (!counter || !validId(counter.seq)) {
    throw new Error('Shipment counter unavailable');
  }

  try {
    const shipment = await Shipment.create({
      sid: counter.seq,
      oid: event.oid,
      uid: event.uid,
      event_id: event.event_id,
      status: 'PENDING'
    });

    console.log(
      'Shipment created:',
      shipment.sid,
      '- Order:',
      shipment.oid
    );

    return shipment;
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }

    // Hai luot xu ly cung su kien co the chay dong thoi.
    // Unique index ngan tao van don trung.
    const shipment = await Shipment.findOne({
      $or: [
        { oid: event.oid },
        { event_id: event.event_id }
      ]
    });

    if (!shipment) {
      throw error;
    }

    checkExisting(shipment, event);
    return shipment;
  }
}

async function startConsumer() {
  const brokers = process.env.KAFKA_BROKERS;
  const groupId = process.env.KAFKA_GROUP_ID;
  const topic = process.env.KAFKA_ORDER_TOPIC;

  if (!brokers || !groupId || !topic) {
    throw new Error('Thieu cau hinh Kafka cho Shipment');
  }

  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'shipment-service',
    brokers: brokers.split(',').map(value => value.trim()),
    connectionTimeout: 5000,
    requestTimeout: 30000,
    retry: { retries: 5 }
  });

  consumer = kafka.consumer({
    groupId,
    allowAutoTopicCreation: false
  });

  consumer.on(consumer.events.GROUP_JOIN, () => {
    ready = true;
    console.log('Shipment consumer joined group');
  });

  consumer.on(consumer.events.CRASH, event => {
    ready = false;
    console.error(
      'Shipment consumer crashed:',
      event.payload.error.message
    );
  });

  consumer.on(consumer.events.DISCONNECT, () => {
    ready = false;
  });

  consumer.on(consumer.events.STOP, () => {
    ready = false;
  });

  await consumer.connect();

  await consumer.subscribe({
    topic,
    fromBeginning: true
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) {
        throw new Error('Su kien Kafka khong co noi dung');
      }

      const event = JSON.parse(message.value.toString('utf8'));

      // Chi hoan tat xu ly message sau khi MongoDB luu thanh cong.
      await createFromEvent(event);
    }
  });

  console.log('Shipment consumer started:', topic);
}

async function stopConsumer() {
  ready = false;

  if (consumer) {
    await consumer.disconnect();
  }
}

function consumerReady() {
  return ready;
}

module.exports = {
  startConsumer,
  stopConsumer,
  consumerReady
};