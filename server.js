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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/deduct', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'deduct.html'));
});

// ------------------- API الزبائن والخصم -------------------

// 1. الاستعلام عن رصيد الزبون
app.get('/api/customers/:phone', async (req, res) => {
    try {
        const phone = req.params.phone.trim();
        const result = await pool.query('SELECT name, coupons FROM customers WHERE TRIM(phone) = $1', [phone]);

        if (result.rows.length > 0) {
            res.json({ success: true, name: result.rows[0].name, coupons: result.rows[0].coupons });
        } else {
            res.status(404).json({ success: false, message: 'الزبون غير مسجل في النظام' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ في الاتصال بالخادم' });
    }
});

// 2. خصم الكوبونات بواسطة الموزع
app.post('/api/deduct-coupon', async (req, res) => {
    try {
        const { customerPhone, driverPhone, driverPassword, amount } = req.body;
        const deductAmount = parseInt(amount, 10) || 1;

        const dPhone = String(driverPhone || '').trim();
        const dPass = String(driverPassword || '').trim();
        const cPhone = String(customerPhone || '').trim();

        // التحقق من الموزع
        const driverCheck = await pool.query(
            'SELECT name FROM drivers WHERE TRIM(phone) = $1 AND TRIM(password) = $2',
            [dPhone, dPass]
        );
        if (driverCheck.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'بيانات الموزع غير صحيحة' });
        }

        // التحقق من الزبون
        const custCheck = await pool.query('SELECT id, name, coupons FROM customers WHERE TRIM(phone) = $1', [cPhone]);
        if (custCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'رقم الزبون غير مسجل في النظام' });
        }

        const customer = custCheck.rows[0];
        const currentCoupons = parseInt(customer.coupons, 10) || 0;

        if (currentCoupons < deductAmount) {
            return res.status(400).json({ success: false, message: 'رصيد الزبون لا يكفي للخصم' });
        }

        // تحديث رصيد الزبون
        const newBalance = currentCoupons - deductAmount;
        await pool.query('UPDATE customers SET coupons = $1 WHERE id = $2', [newBalance, customer.id]);

        // تسجيل الحركة
        const driverName = driverCheck.rows[0].name || 'موزع';
        await pool.query(
            'INSERT INTO transactions (customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5)',
            [cPhone, customer.name, 'خصم', deductAmount, driverName]
        );

        res.json({
            success: true,
            message: `تم خصم ${deductAmount} كوبون بنجاح`,
            customerName: customer.name,
            newBalance: newBalance
        });
    } catch (err) {
        console.error('Error deducting coupons:', err.message);
        res.status(500).json({ success: false, message: 'خطأ أثناء تنفيذ الخصم' });
    }
});

// ------------------- API المحطة والإدارة -------------------

// إضافة زبون أو شحن رصيده
app.post('/api/customers', async (req, res) => {
    try {
        const { name, phone, coupons } = req.body;
        const addAmount = parseInt(coupons, 10) || 0;
        const cleanPhone = String(phone || '').trim();
        const cleanName = String(name || '').trim();

        if (!cleanPhone || !cleanName) {
            return res.status(400).json({ success: false, message: 'يرجى إدخال اسم ورقم الزبون' });
        }

        const checkCust = await pool.query('SELECT id, coupons FROM customers WHERE TRIM(phone) = $1', [cleanPhone]);

        if (checkCust.rows.length > 0) {
            const currentCoupons = parseInt(checkCust.rows[0].coupons, 10) || 0;
            const newCoupons = currentCoupons + addAmount;
            await pool.query('UPDATE customers SET coupons = $1, name = $2 WHERE id = $3', [newCoupons, cleanName, checkCust.rows[0].id]);
        } else {
            await pool.query('INSERT INTO customers (name, phone, coupons) VALUES ($1, $2, $3)', [cleanName, cleanPhone, addAmount]);
        }

        await pool.query(
            'INSERT INTO transactions (customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5)',
            [cleanPhone, cleanName, 'شحن', addAmount, 'المحطة']
        );

        res.json({ success: true, message: 'تم حفظ وشحن رصيد الزبون بنجاح' });
    } catch (err) {
        console.error('Error in /api/customers:', err.message);
        res.status(500).json({ success: false, message: 'خطأ أثناء إضافة/شحن الزبون' });
    }
});

// إضافة موزع جديد
app.post('/api/drivers', async (req, res) => {
    try {
        const { name, phone, password } = req.body;
        const cleanPhone = String(phone || '').trim();
        const cleanName = String(name || '').trim();
        const cleanPassword = String(password || '').trim();

        if (!cleanName || !cleanPhone || !cleanPassword) {
            return res.status(400).json({ success: false, message: 'يرجى إدخال كافة بيانات الموزع' });
        }

        await pool.query('INSERT INTO drivers (name, phone, password) VALUES ($1, $2, $3)', [cleanName, cleanPhone, cleanPassword]);
        res.json({ success: true, message: 'تمت إضافة الموزع بنجاح' });
    } catch (err) {
        console.error('Error adding driver:', err.message);
        res.status(400).json({ success: false, message: 'رقم هاتف الموزع مسجل مسبقاً أو حدث خطأ' });
    }
});

// تسجيل دخول المحطة
app.post('/api/station/login', async (req, res) => {
    try {
        const phone = String(req.body.phone || '').trim();
        const password = String(req.body.password || '').trim();
        
        const result = await pool.query('SELECT * FROM stations WHERE TRIM(phone) = $1 AND TRIM(password) = $2', [phone, password]);

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

// تغيير كلمة المرور للمحطة
app.post('/api/station/change-password', async (req, res) => {
    try {
        const phone = String(req.body.phone || '').trim();
        const currentPassword = String(req.body.currentPassword || '').trim();
        const newPassword = String(req.body.newPassword || '').trim();

        const checkStation = await pool.query(
            'SELECT id FROM stations WHERE TRIM(phone) = $1 AND TRIM(password) = $2',
            [phone, currentPassword]
        );

        if (checkStation.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
        }

        await pool.query(
            'UPDATE stations SET password = $1 WHERE TRIM(phone) = $2',
            [newPassword, phone]
        );

        res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'خطأ أثناء تغيير كلمة المرور' });
    }
});

// جلب الإحصائيات
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