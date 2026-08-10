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

// ------------------- API المحطة والإدارة -------------------

// 1. تسجيل دخول المحطة
app.post('/api/station/login', async (req, res) => {
    try {
        const phone = String(req.body.phone || '').trim();
        const password = String(req.body.password || '').trim();
        
        const result = await pool.query('SELECT id, name, phone FROM stations WHERE TRIM(phone) = $1 AND TRIM(password) = $2', [phone, password]);

        if (result.rows.length > 0) {
            res.json({ success: true, station: result.rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'بيانات دخول المحطة غير صحيحة' });
        }
    } catch (err) {
        console.error('Error in station login:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
});

// 2. إنشاء محطة جديدة (إنشاء حساب لمحطة عند البيع)
app.post('/api/station/register', async (req, res) => {
    try {
        const { name, phone, password } = req.body;
        const cleanName = String(name || '').trim();
        const cleanPhone = String(phone || '').trim();
        const cleanPassword = String(password || '').trim();

        if (!cleanName || !cleanPhone || !cleanPassword) {
            return res.status(400).json({ success: false, message: 'يرجى إدخال كافة بيانات المحطة' });
        }

        const result = await pool.query(
            'INSERT INTO stations (name, phone, password) VALUES ($1, $2, $3) RETURNING id, name, phone',
            [cleanName, cleanPhone, cleanPassword]
        );

        res.json({ success: true, message: 'تم إنشاء المحطة بنجاح', station: result.rows[0] });
    } catch (err) {
        console.error('Error registering station:', err.message);
        res.status(400).json({ success: false, message: 'رقم هاتف المحطة مسجل مسبقاً أو حدث خطأ' });
    }
});

// 3. إضافة زبون أو شحن رصيده
app.post('/api/customers', async (req, res) => {
    try {
        const { stationId, name, phone, coupons } = req.body;
        const addAmount = parseInt(coupons, 10) || 0;
        const cleanPhone = String(phone || '').trim();
        const cleanName = String(name || '').trim();
        const sId = parseInt(stationId, 10);

        if (!sId || !cleanPhone || !cleanName) {
            return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
        }

        const checkCust = await pool.query(
            'SELECT id, coupons FROM customers WHERE TRIM(phone) = $1 AND station_id = $2',
            [cleanPhone, sId]
        );

        if (checkCust.rows.length > 0) {
            const currentCoupons = parseInt(checkCust.rows[0].coupons, 10) || 0;
            const newCoupons = currentCoupons + addAmount;
            await pool.query(
                'UPDATE customers SET coupons = $1, name = $2 WHERE id = $3 AND station_id = $4',
                [newCoupons, cleanName, checkCust.rows[0].id, sId]
            );
        } else {
            await pool.query(
                'INSERT INTO customers (station_id, name, phone, coupons) VALUES ($1, $2, $3, $4)',
                [sId, cleanName, cleanPhone, addAmount]
            );
        }

        // تسجيل الحركة للمحطة
        await pool.query(
            'INSERT INTO transactions (station_id, customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5, $6)',
            [sId, cleanPhone, cleanName, 'شحن', addAmount, 'المحطة']
        );

        res.json({ success: true, message: 'تم حفظ وشحن رصيد الزبون بنجاح' });
    } catch (err) {
        console.error('Error in /api/customers:', err.message);
        res.status(500).json({ success: false, message: 'خطأ أثناء شحن الزبون: ' + err.message });
    }
});

// 4. إضافة موزع جديد للمحطة
app.post('/api/drivers', async (req, res) => {
    try {
        const { stationId, name, phone, password } = req.body;
        const sId = parseInt(stationId, 10);
        const cleanPhone = String(phone || '').trim();
        const cleanName = String(name || '').trim();
        const cleanPassword = String(password || '').trim();

        if (!sId || !cleanName || !cleanPhone || !cleanPassword) {
            return res.status(400).json({ success: false, message: 'يرجى إدخال كافة بيانات الموزع' });
        }

        await pool.query(
            'INSERT INTO drivers (station_id, name, phone, password) VALUES ($1, $2, $3, $4)',
            [sId, cleanName, cleanPhone, cleanPassword]
        );
        res.json({ success: true, message: 'تمت إضافة الموزع بنجاح' });
    } catch (err) {
        console.error('Error adding driver:', err.message);
        res.status(400).json({ success: false, message: 'رقم هاتف الموزع مسجل مسبقاً أو حدث خطأ' });
    }
});

// 5. جلب الإحصائيات الخاصة بمحطة معينة
app.get('/api/station/:stationId/stats', async (req, res) => {
    try {
        const sId = parseInt(req.params.stationId, 10);

        const recharged = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE station_id = $1 AND action_type = 'شحن'", [sId]);
        const deducted = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE station_id = $1 AND action_type = 'خصم'", [sId]);
        const balance = await pool.query("SELECT COALESCE(SUM(coupons), 0) as total FROM customers WHERE station_id = $1", [sId]);

        const driverStats = await pool.query(`
            SELECT driver_name, COUNT(*) as operations_count, COALESCE(SUM(amount), 0) as total_deducted 
            FROM transactions 
            WHERE station_id = $1 AND action_type = 'خصم' 
            GROUP BY driver_name
        `, [sId]);

        res.json({
            success: true,
            stats: {
                totalRecharged: parseInt(recharged.rows[0].total, 10),
                totalDeducted: parseInt(deducted.rows[0].total, 10),
                totalBalance: parseInt(balance.rows[0].total, 10),
                driverStats: driverStats.rows
            }
        });
    } catch (err) {
        console.error('Error in stats:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في جلب الإحصائيات' });
    }
});

// 6. سجل الحركات لمرحلة معينة
app.get('/api/station/:stationId/transactions', async (req, res) => {
    try {
        const sId = parseInt(req.params.stationId, 10);
        const result = await pool.query('SELECT * FROM transactions WHERE station_id = $1 ORDER BY id DESC LIMIT 30', [sId]);
        res.json({ success: true, transactions: result.rows });
    } catch (err) {
        console.error('Error fetching transactions:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في جلب السجلات' });
    }
});

// ------------------- API الموزعين والخصم والزبائن -------------------

// 1. الاستعلام عن رصيد الزبون برقم الهاتف واسم/معرف المحطة
app.get('/api/customers/:phone', async (req, res) => {
    try {
        const phone = req.params.phone.trim();
        const stationId = req.query.stationId;

        let query = 'SELECT c.name, c.coupons, s.name as station_name FROM customers c JOIN stations s ON c.station_id = s.id WHERE TRIM(c.phone) = $1';
        let params = [phone];

        if (stationId) {
            query += ' AND c.station_id = $2';
            params.push(stationId);
        }

        const result = await pool.query(query, params);

        if (result.rows.length > 0) {
            res.json({
                success: true,
                name: result.rows[0].name,
                coupons: result.rows[0].coupons,
                stationName: result.rows[0].station_name
            });
        } else {
            res.status(404).json({ success: false, message: 'الزبون غير مسجل في هذه المحطة' });
        }
    } catch (err) {
        console.error('Error fetching customer:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في الاتصال بالسيرفر' });
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

        // التحقق من الموزع ومرفق المحطة التي يتبع لها
        const driverCheck = await pool.query(
            'SELECT id, name, station_id FROM drivers WHERE TRIM(phone) = $1 AND TRIM(password) = $2',
            [dPhone, dPass]
        );

        if (driverCheck.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'بيانات الموزع غير صحيحة' });
        }

        const driver = driverCheck.rows[0];
        const stationId = driver.station_id;

        // التحقق من الزبون التابع لنفس محطة الموزع
        const custCheck = await pool.query(
            'SELECT id, name, coupons FROM customers WHERE TRIM(phone) = $1 AND station_id = $2',
            [cPhone, stationId]
        );

        if (custCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'الزبون غير مسجل في محطة هذا الموزع' });
        }

        const customer = custCheck.rows[0];
        const currentCoupons = parseInt(customer.coupons, 10) || 0;

        if (currentCoupons < deductAmount) {
            return res.status(400).json({ success: false, message: 'رصيد الزبون لا يكفي للخصم' });
        }

        // تحديث رصيد الزبون
        const newBalance = currentCoupons - deductAmount;
        await pool.query('UPDATE customers SET coupons = $1 WHERE id = $2', [newBalance, customer.id]);

        // تسجيل الحركة للمحطة
        await pool.query(
            'INSERT INTO transactions (station_id, customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5, $6)',
            [stationId, cPhone, customer.name, 'خصم', deductAmount, driver.name]
        );

        res.json({
            success: true,
            message: `تم خصم ${deductAmount} كوبون بنجاح`,
            customerName: customer.name,
            newBalance: newBalance
        });
    } catch (err) {
        console.error('Error deducting coupons:', err.message);
        res.status(500).json({ success: false, message: 'خطأ أثناء تنفيذ الخصم: ' + err.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`السيرفر يعمل على المنفذ ${PORT}`);
});