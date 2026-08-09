require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// الاتصال بقاعدة بيانات PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') 
    ? { rejectUnauthorized: false } 
    : false
});

// تهيئة الجداول في PostgreSQL عند تشغيل السيرفر
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS drivers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        coupons INT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
        driver_id INT REFERENCES drivers(id) ON DELETE SET NULL,
        action_type VARCHAR(20) NOT NULL,
        amount INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // إضافة المحطة الافتراضية إذا لم تكن موجودة مع تشفير كلمة المرور
    const stationRes = await client.query('SELECT * FROM stations WHERE phone = $1', ['0700000000']);
    if (stationRes.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await client.query(
        'INSERT INTO stations (name, phone, password) VALUES ($1, $2, $3)',
        ['محطة المياه المركزية', '0700000000', hashedPassword]
      );
      console.log('✅ تم إنشاء حساب المحطة الافتراضي وتشفير كلمة المرور.');
    }
  } catch (err) {
    console.error('❌ خطأ في تهيئة قاعدة البيانات:', err);
  } finally {
    client.release();
  }
}

initDb();

// Middleware للتحقق من الـ JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'غير مصرح للوصول' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'الجلسة منتهية أو غير صالحة' });
    req.user = user;
    next();
  });
}

// ==================== APIs الزبائن ====================

// استعلام الزبون عن رصيده
app.get('/api/customers/:phone', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM customers WHERE phone = $1', [req.params.phone]);
    if (rows.length === 0) {
      return res.status(44).json({ success: false, message: 'رقم الهاتف غير مسجل' });
    }
    res.json({ success: true, customer: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// إضافة زبون جديد أو شحن رصيد
app.post('/api/customers', async (req, res) => {
  const { name, phone, coupons } = req.body;
  const couponAmount = parseInt(coupons) || 0;

  try {
    let customerRes = await pool.query('SELECT * FROM customers WHERE phone = $1', [phone]);
    let customer;

    if (customerRes.rows.length > 0) {
      customer = customerRes.rows[0];
      const newBalance = customer.coupons + couponAmount;
      await pool.query('UPDATE customers SET coupons = $1 WHERE id = $2', [newBalance, customer.id]);
    } else {
      const newCust = await pool.query(
        'INSERT INTO customers (name, phone, coupons) VALUES ($1, $2, $3) RETURNING *',
        [name || 'زبون جديد', phone, couponAmount]
      );
      customer = newCust.rows[0];
    }

    await pool.query(
      'INSERT INTO transactions (customer_id, action_type, amount) VALUES ($1, $2, $3)',
      [customer.id, 'recharge', couponAmount]
    );

    res.json({ success: true, message: 'تم الشحن بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ أثناء تنفيذ العملية' });
  }
});

// ==================== APIs الموزعين والخصم ====================

// تسجيل دخول الموزع
app.post('/api/drivers/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM drivers WHERE phone = $1', [phone]);
    if (rows.length === 0) return res.json({ success: false, message: 'رقم الهاتف أو كلمة المرور غير صحيحة' });

    const driver = rows[0];
    const validPass = await bcrypt.compare(password, driver.password);
    if (!validPass) return res.json({ success: false, message: 'رقم الهاتف أو كلمة المرور غير صحيحة' });

    const token = jwt.sign({ id: driver.id, role: 'driver', name: driver.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, driver: { id: driver.id, name: driver.name } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// إضافة موزع جديد (بواسطة المحطة)
app.post('/api/drivers', async (req, res) => {
  const { name, phone, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO drivers (name, phone, password) VALUES ($1, $2, $3)',
      [name, phone, hashedPassword]
    );
    res.json({ success: true, message: 'تم إضافة الموزع بنجاح' });
  } catch (err) {
    res.status(400).json({ success: false, error: 'رقم الهاتف مستخدم بالفعل' });
  }
});

// خصم كوبونات بواسطة الموزع
app.post('/api/coupons/deduct', async (req, res) => {
  const { customerPhone, driverPhone, driverPassword, couponsDeducted } = req.body;
  const deductAmount = parseInt(couponsDeducted) || 1;

  try {
    const driverRes = await pool.query('SELECT * FROM drivers WHERE phone = $1', [driverPhone]);
    if (driverRes.rows.length === 0) return res.json({ success: false, message: 'بيانات الموزع غير صحيحة' });
    
    const driver = driverRes.rows[0];
    const validPass = await bcrypt.compare(driverPassword, driver.password);
    if (!validPass) return res.json({ success: false, message: 'بيانات الموزع غير صحيحة' });

    const custRes = await pool.query('SELECT * FROM customers WHERE phone = $1', [customerPhone]);
    if (custRes.rows.length === 0) return res.json({ success: false, message: 'الزبون غير موجود' });

    const customer = custRes.rows[0];
    if (customer.coupons < deductAmount) return res.json({ success: false, message: 'رصيد الزبون لا يكفي' });

    const newBalance = customer.coupons - deductAmount;
    await pool.query('UPDATE customers SET coupons = $1 WHERE id = $2', [newBalance, customer.id]);

    await pool.query(
      'INSERT INTO transactions (customer_id, driver_id, action_type, amount) VALUES ($1, $2, $3, $4)',
      [customer.id, driver.id, 'deduct', deductAmount]
    );

    res.json({ success: true, message: 'تم خصم الكوبون بنجاح', remainingCoupons: newBalance });
  } catch (err) {
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء الخصم' });
  }
});

// ==================== APIs المحطة والإحصائيات ====================

// تسجيل دخول المحطة
app.post('/api/station/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM stations WHERE phone = $1', [phone]);
    if (rows.length === 0) return res.json({ success: false, message: 'بيانات الدخول غير صحيحة' });

    const station = rows[0];
    const validPass = await bcrypt.compare(password, station.password);
    if (!validPass) return res.json({ success: false, message: 'بيانات الدخول غير صحيحة' });

    const token = jwt.sign({ id: station.id, role: 'station', name: station.name }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ success: true, token, station: { name: station.name } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// إحصائيات المحطة
app.get('/api/station/stats', async (req, res) => {
  try {
    const rechargedRes = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE action_type = 'recharge'");
    const deductedRes = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE action_type = 'deduct'");
    const balanceRes = await pool.query("SELECT COALESCE(SUM(coupons), 0) AS total FROM customers");

    const driverStatsRes = await pool.query(`
      SELECT d.name AS driver_name, COUNT(t.id) AS operations_count, COALESCE(SUM(t.amount), 0) AS total_deducted
      FROM drivers d
      LEFT JOIN transactions t ON d.id = t.driver_id AND t.action_type = 'deduct'
      GROUP BY d.id, d.name
    `);

    res.json({
      success: true,
      stats: {
        totalRecharged: rechargedRes.rows[0].total,
        totalDeducted: deductedRes.rows[0].total,
        totalBalance: balanceRes.rows[0].total,
        driverStats: driverStatsRes.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ أثناء تحميل الإحصائيات' });
  }
});

app.get('/api/station/transactions', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.name AS customer_name, c.phone AS customer_phone, t.action_type, t.amount, COALESCE(d.name, 'المحطة') AS driver_name
      FROM transactions t
      JOIN customers c ON t.customer_id = c.id
      LEFT JOIN drivers d ON t.driver_id = d.id
      ORDER BY t.created_at DESC
      LIMIT 50
    `);
    res.json({ success: true, transactions: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ أثناء تحميل السجل' });
  }
});

app.listen(PORT, () => console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`));