const grpc = require('@grpc/grpc-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function createAuthHandlers(pool) {
  async function register(call, callback) {
    const username = (call.request.username || '').trim();
    const password = call.request.password || '';
    const email = (call.request.email || '').trim().toLowerCase();
    const phone = (call.request.phone || '').trim();

    if (
      !username ||
      username.length > 50 ||
      password.length < 6 ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      email.length > 255 ||
      (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      phone.length > 20
    ) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        details: 'Du lieu khong hop le; mat khau can it nhat 6 ky tu'
      });
    }

    let client;
    let discardConnection = false;
    let transactionStarted = false;
    let uid;
    let failure;

    try {
      const hashedPassword = await bcrypt.hash(password, 12);

      client = await pool.connect();

      await client.query('BEGIN');
      transactionStarted = true;

      const result = await client.query(`
        INSERT INTO users (
          username,
          password,
          email,
          phone,
          roleid
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          (SELECT roleid FROM roles WHERE rolename = 'CUSTOMER')
        )
        RETURNING uid
      `, [
        username,
        hashedPassword,
        email || null,
        phone || null
      ]);

      uid = result.rows[0].uid;

      await client.query(`
        INSERT INTO customer_provisioning (uid, fullname)
        VALUES ($1, $2)
      `, [uid, username]);

      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      failure = error;

      if (client && transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discardConnection = true;
        }
      }
    } finally {
      if (client) {
        client.release(discardConnection);
      }
    }

    if (failure) {
      if (failure.code === '23505') {
        return callback({
          code: grpc.status.ALREADY_EXISTS,
          details: 'Username hoac email da ton tai'
        });
      }

      console.error('Register failed:', failure.message);

      return callback({
        code: grpc.status.INTERNAL,
        details: 'Khong the xac nhan dang ky; hay kiem tra dang nhap truoc khi thu lai'
      });
    }

    callback(null, {
      uid,
      message: 'User registered successfully'
    });
  }

  async function login(call, callback) {
    const username = (call.request.username || '').trim();
    const password = call.request.password || '';

    if (
      !username ||
      username.length > 50 ||
      !password ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        details: 'Username hoac password khong hop le'
      });
    }

    try {
      const result = await pool.query(`
        SELECT u.uid, u.password, r.rolename
        FROM users u
        JOIN roles r ON r.roleid = u.roleid
        WHERE u.username = $1
      `, [username]);

      const user = result.rows[0];

      if (!user || !(await bcrypt.compare(password, user.password))) {
        return callback({
          code: grpc.status.UNAUTHENTICATED,
          details: 'Sai username hoac password'
        });
      }

      const accessToken = jwt.sign(
        { role: user.rolename },
        process.env.JWT_SECRET,
        {
          algorithm: 'HS256',
          subject: String(user.uid),
          issuer: 'ecommerce-auth',
          audience: 'ecommerce-api',
          expiresIn: process.env.JWT_EXPIRES_IN || '1h'
        }
      );

      const payload = jwt.decode(accessToken);

      callback(null, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: payload.exp - payload.iat
      });
    } catch (error) {
      console.error('Login failed:', error.message);

      callback({
        code: grpc.status.INTERNAL,
        details: 'Khong the dang nhap'
      });
    }
  }

  function verifyToken(call, callback) {
    try {
      const payload = jwt.verify(
        call.request.token || '',
        process.env.JWT_SECRET,
        {
          algorithms: ['HS256'],
          issuer: 'ecommerce-auth',
          audience: 'ecommerce-api'
        }
      );

      const uid = Number(payload.sub);
      const roles = ['CUSTOMER', 'ADMIN', 'SHIPMENT_STAFF'];

      if (
        !Number.isInteger(uid) ||
        uid <= 0 ||
        uid > 2147483647 ||
        !roles.includes(payload.role)
      ) {
        throw new Error('Invalid token claims');
      }

      callback(null, {
        uid,
        role: payload.role
      });
    } catch {
      callback({
        code: grpc.status.UNAUTHENTICATED,
        details: 'Token khong hop le hoac da het han'
      });
    }
  }

  return {
    register,
    login,
    verifyToken
  };
}

module.exports = createAuthHandlers;