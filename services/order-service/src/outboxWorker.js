const { Kafka, Partitioners } = require('kafkajs');
const { pool } = require('./db');

const brokers = process.env.KAFKA_BROKERS;
const topic = process.env.KAFKA_ORDER_TOPIC;

if (!brokers || !topic) {
  throw new Error('Thieu KAFKA_BROKERS hoac KAFKA_ORDER_TOPIC');
}

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'order-service',
  brokers: brokers.split(',').map(value => value.trim()),
  connectionTimeout: 5000,
  requestTimeout: 10000,
  retry: { retries: 3 }
});

const producer = kafka.producer({
  createPartitioner: Partitioners.DefaultPartitioner,
  allowAutoTopicCreation: false
});

let stopping = false;
let wakeUp;

function pause() {
  return new Promise(resolve => {
    const timer = setTimeout(done, 2000);

    function done() {
      clearTimeout(timer);
      wakeUp = undefined;
      resolve();
    }

    wakeUp = done;

    if (stopping) done();
  });
}

async function publishOne() {
  const client = await pool.connect();
  let discard = false;

  try {
    await client.query('BEGIN');

    const result = await client.query(`
      SELECT *
      FROM outbox_events
      WHERE published_at IS NULL
        AND event_type = 'OrderCreated'
      ORDER BY created_at, event_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    const event = result.rows[0];

    if (!event) {
      await client.query('COMMIT');
      return false;
    }

    await producer.send({
      topic,
      acks: -1,
      timeout: 10000,
      messages: [
        {
          key: String(event.aggregate_id),
          value: JSON.stringify(event.payload),
          headers: {
            event_id: event.event_id,
            event_type: event.event_type
          }
        }
      ]
    });

    // Chi danh dau sau khi Kafka xac nhan nhan su kien.
    await client.query(`
      UPDATE outbox_events
      SET published_at = NOW()
      WHERE event_id = $1
    `, [event.event_id]);

    await client.query('COMMIT');

    console.log(
      'Published OrderCreated:',
      event.event_id,
      '- Order:',
      event.aggregate_id
    );

    return true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }

    throw error;
  } finally {
    client.release(discard);
  }
}

async function main() {
  try {
    await pool.query('SELECT 1');
    await producer.connect();

    console.log('Outbox worker connected to Kafka');

    while (!stopping) {
      try {
        const published = await publishOne();

        if (!published && !stopping) {
          await pause();
        }
      } catch (error) {
        console.error('Publish failed:', error.message);

        if (!stopping) {
          await pause();
        }
      }
    }
  } finally {
    try {
      await producer.disconnect();
    } finally {
      await pool.end();
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (wakeUp) wakeUp();
  });
}

main().catch(error => {
  console.error('Outbox worker failed:', error.message);
  process.exitCode = 1;
});