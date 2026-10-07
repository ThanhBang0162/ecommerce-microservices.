const path = require('node:path');
const { Pool } = require('pg');

require('dotenv').config({
  path: path.join(__dirname, '../.env')
});

if (!process.env.DATABASE_URL) {
  throw new Error('Thieu DATABASE_URL');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 10
});

pool.on('error', error => {
  console.error('Order DB pool error:', error.message);
});

async function transaction(work) {
  const client = await pool.connect();
  let discardConnection = false;

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardConnection = true;
    }

    throw error;
  } finally {
    client.release(discardConnection);
  }
}

module.exports = { pool, transaction };