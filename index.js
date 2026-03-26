require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

function generateReferralCode(telegram_id) {
  return `KC${telegram_id}${Math.floor(Math.random() * 1000)}`;
}

// Create DB connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Print a clear connectivity status on startup
(async () => {
  try {
    const r = await pool.query('SELECT 1 as ok');
    console.log('Database connected ✅', r.rows[0]);
  } catch (err) {
    console.error('Database connection failed ❌');
    console.error({
      name: err?.name,
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
    });
  }
})();

// Test route
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      message: 'Database connected ✅',
      time: result.rows[0].now,
    });
  } catch (err) {
    console.error('DB query failed ❌', {
      name: err?.name,
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
    });
    res.status(500).send('Database connection failed ❌');
  }
});

app.get('/init-db', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username TEXT,
        referral_code TEXT UNIQUE,
        referred_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.send('Users table created ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to create table ❌');
  }
});

app.post('/user/create', async (req, res) => {
  const { telegram_id, username, referral_code_used } = req.body;

  try {
    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegram_id]
    );

    if (existingUser.rows.length > 0) {
      return res.json({
        message: 'User already exists',
        user: existingUser.rows[0],
      });
    }

    // Generate referral code
    const referral_code = generateReferralCode(telegram_id);

    let referrer = null;

    if (referral_code_used) {
      const refResult = await pool.query(
        'SELECT * FROM users WHERE referral_code = $1',
        [referral_code_used]
      );

      if (refResult.rows.length > 0) {
        referrer = refResult.rows[0];
      }
    }

    // Insert new user
    const result = await pool.query(
      `INSERT INTO users (telegram_id, username, referral_code, referred_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        telegram_id,
        username,
        referral_code,
        referrer ? referrer.referral_code : null,
      ]
    );

    if (referrer) {
      console.log(`Referral success: ${referrer.username} invited ${username}`);
    }

    res.json({
      message: 'User created ✅',
      user: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating user ❌');
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

