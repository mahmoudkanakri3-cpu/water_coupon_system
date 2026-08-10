const express = require('express');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ------------------- توجيه الصفحات -------------------

// الصفحة الرئيسية (شاشة المحطة)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'station.html'));
});

// شاشة الخصم والاستعلام
app.get('/deduct', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// مسار فرعي لشاشة المحطة للتوافق
app.get('/station', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'station.html'));
});

// ------------------- API الزبائن -------------------

// الاستعلام عن رصيد زبون (Query Param)
app.get('/api/check-balance', async (req, res) => {
    try {
        const { phone } = req.query;
        const result = await pool.query('SELECT name, coupons FROM customers WHERE phone = $1', [phone]);

        if (result.rows.length > 0) {
            res.json({ success: true, name: result.rows[0].name, coupons: result.rows[0].coupons });
        } else {
            res.status(404).json({ success: false, message: 'الزبون غير موجود' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
});

// الاستعلام عن رصيد زبون (URL Param)
app.get('/api/customers/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const result = await pool.query('SELECT name, coupons FROM customers WHERE phone = $1', [phone]);

        if (result.rows.length > 0) {
            res.json({ success: true, name: result.rows[0].name, coupons: result.rows[0].coupons });
        } else {
            res.status(404).json({ success: false, message: 'الزبون غير موجود' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
});

// خصم كوبونات بواسطة الموزع
app.post('/api/deduct-coupon', async (req, res) => {
    try {
        const { customerPhone, driverPhone, driverPassword, amount } = req.body;
        const deductAmount = parseInt(amount) || 1;

        // التحقق من الموزع
        const driverCheck = await pool.query(
            'SELECT name FROM drivers WHERE phone = $1 AND password = $2',
            [driverPhone, driverPassword]
        );
        if (driverCheck.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'بيانات الموزع غير صحيحة' });
        }

        // التحقق من الزبون ورصيده
        const custCheck = await pool.query('SELECT id, name, coupons FROM customers WHERE phone = $1', [customerPhone]);
        if (custCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'الزبون غير موجود' });
        }

        const customer = custCheck.rows[0];
        if (customer.coupons < deductAmount) {
            return res.status(400).json({ success: false, message: 'رصيد الكوبونات غير كافٍ' });
        }

        // خصم الكوبونات
        const newBalance = customer.coupons - deductAmount;
        await pool.query('UPDATE customers SET coupons = $1 WHERE id = $2', [newBalance, customer.id]);

        // تسجيل الحركة
        await pool.query(
            'INSERT INTO transactions (customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5)',
            [customerPhone, customer.name, 'خصم', deductAmount, driverCheck.rows[0].name]
        );

        res.json({
            success: true,
            message: `تم خصم ${deductAmount} كوبون بنجاح`,
            customerName: customer.name,
            newBalance: newBalance
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ في تنفيذ عملية الخصم' });
    }
});

// ------------------- API المحطة الإدارية -------------------

// إضافة زبون جديد أو شحن رصيده
app.post('/api/customers', async (req, res) => {
    try {
        const { name, phone, coupons } = req.body;
        const addAmount = parseInt(coupons) || 0;

        const checkCust = await pool.query('SELECT id, coupons FROM customers WHERE phone = $1', [phone]);

        if (checkCust.rows.length > 0) {
            const newCoupons = checkCust.rows[0].coupons + addAmount;
            await pool.query('UPDATE customers SET coupons = $1, name = $2 WHERE phone = $3', [newCoupons, name, phone]);
        } else {
            await pool.query('INSERT INTO customers (name, phone, coupons) VALUES ($1, $2, $3)', [name, phone, addAmount]);
        }

        await pool.query(
            'INSERT INTO transactions (customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5)',
            [phone, name, 'شحن', addAmount, 'المحطة']
        );

        res.json({ success: true, message: 'تم حفظ وشحن رصيد الزبون بنجاح' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ أثناء إضافة/شحن الزبون' });
    }
});

// إضافة موزع جديد
app.post('/api/drivers', async (req, res) => {
    try {
        const { name, phone, password } = req.body;
        await pool.query('INSERT INTO drivers (name, phone, password) VALUES ($1, $2, $3)', [name, phone, password]);
        res.json({ success: true, message: 'تمت إضافة الموزع بنجاح' });
    } catch (err) {
        console.error(err);
        res.status(400).json({ success: false, error: 'رقم هاتف الموزع مسجل مسبقاً أو بيانات غير صحيحة' });
    }
});

// تسجيل دخول المحطة
app.post('/api/station/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const result = await pool.query('SELECT * FROM stations WHERE phone = $1 AND password = $2', [phone, password]);

        if (result.rows.length > 0) {
            res.json({ success: true, station: result.rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'بيانات دخول المحطة غير صحيحة' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
});

// إحصائيات لوحة التحكم
app.get('/api/station/stats', async (req, res) => {
    try {
        const recharged = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE action_type = 'شحن'");
        const deducted = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE action_type = 'خصم'");
        const balance = await pool.query("SELECT COALESCE(SUM(coupons), 0) as total FROM customers");

        const driverStats = await pool.query(`
            SELECT driver_name, COUNT(*) as operations_count, SUM(amount) as total_deducted 
            FROM transactions 
            WHERE action_type = 'خصم' 
            GROUP BY driver_name
        `);

        res.json({
            success: true,
            stats: {
                totalRecharged: recharged.rows[0].total,
                totalDeducted: deducted.rows[0].total,
                totalBalance: balance.rows[0].total,
                driverStats: driverStats.rows
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ في جلب الإحصائيات' });
    }
});

// سجل الحركات
app.get('/api/station/transactions', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transactions ORDER BY id DESC LIMIT 30');
        res.json({ success: true, transactions: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ في جلب السجلات' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`السيرفر يعمل على المنفذ ${PORT}`);
});