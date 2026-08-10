const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// إعداد الاتصال بقاعدة بيانات Supabase / PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// الصفحة الرئيسية لشاشة الخصم والاستعلام
app.get('/deduct', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'deduct.html'));
});

// ==================== 1. مسارات المحطة (STATIONS) ====================

// تسجيل دخول المحطة
app.post('/api/station/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const cleanPhone = String(phone || '').trim();
        const cleanPass = String(password || '').trim();

        const result = await pool.query(
            'SELECT id, name, phone FROM stations WHERE TRIM(phone) = $1 AND TRIM(password) = $2',
            [cleanPhone, cleanPass]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
        }

        res.json({ success: true, station: result.rows[0] });
    } catch (err) {
        console.error('Login station error:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر أثناء الدخول' });
    }
});

// تغيير كلمة مرور المحطة
app.post('/api/station/change-password', async (req, res) => {
    try {
        const { phone, currentPassword, newPassword } = req.body;
        const cPhone = String(phone || '').trim();
        const cPass = String(currentPassword || '').trim();
        const nPass = String(newPassword || '').trim();

        const checkStation = await pool.query(
            'SELECT id FROM stations WHERE TRIM(phone) = $1 AND TRIM(password) = $2',
            [cPhone, cPass]
        );

        if (checkStation.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
        }

        await pool.query(
            'UPDATE stations SET password = $1 WHERE id = $2',
            [nPass, checkStation.rows[0].id]
        );

        res.json({ success: true, message: 'تم تحديث كلمة المرور بنجاح' });
    } catch (err) {
        console.error('Error changing password:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
});

// جلب إحصائيات المحطة
app.get('/api/station/:stationId/stats', async (req, res) => {
    try {
        const { stationId } = req.params;

        // إجمالي الكوبونات المشحونة
        const rechargedRes = await pool.query(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE station_id = $1 AND action_type = 'شحن'",
            [stationId]
        );

        // إجمالي الكوبونات المخصومة
        const deductedRes = await pool.query(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE station_id = $1 AND action_type = 'خصم'",
            [stationId]
        );

        // رصيد الزبائن الحالي
        const balanceRes = await pool.query(
            'SELECT COALESCE(SUM(coupons), 0) AS total FROM customers WHERE station_id = $1',
            [stationId]
        );

        // إحصائيات الموزعين
        const driversRes = await pool.query(
            `SELECT driver_name, COUNT(*) AS operations_count, COALESCE(SUM(amount), 0) AS total_deducted 
             FROM transactions 
             WHERE station_id = $1 AND action_type = 'خصم' AND driver_name != 'المحطة' 
             GROUP BY driver_name 
             ORDER BY total_deducted DESC`,
            [stationId]
        );

        res.json({
            success: true,
            stats: {
                totalRecharged: rechargedRes.rows[0].total,
                totalDeducted: deductedRes.rows[0].total,
                totalBalance: balanceRes.rows[0].total,
                driverStats: driversRes.rows
            }
        });
    } catch (err) {
        console.error('Error fetching station stats:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في جلب الإحصائيات' });
    }
});

// جلب سجل حركات المحطة
app.get('/api/station/:stationId/transactions', async (req, res) => {
    try {
        const { stationId } = req.params;
        const result = await pool.query(
            'SELECT * FROM transactions WHERE station_id = $1 ORDER BY created_at DESC LIMIT 50',
            [stationId]
        );
        res.json({ success: true, transactions: result.rows });
    } catch (err) {
        console.error('Error fetching transactions:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في جلب سجل الحركات' });
    }
});

// ==================== 2. مسارات الزبائن (CUSTOMERS) ====================

// استعلام عن رصيد زبون برقم الهاتف
app.get('/api/customers/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const cleanPhone = String(phone || '').trim();

        const result = await pool.query(
            'SELECT * FROM customers WHERE TRIM(phone) = $1',
            [cleanPhone]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'الزبون غير موجود' });
        }

        res.json({ success: true, customer: result.rows[0] });
    } catch (err) {
        console.error('Error searching customer:', err.message);
        res.status(500).json({ success: false, message: 'خطأ أثناء البحث عن الزبون' });
    }
});

// إضافة أو شحن رصيد زبون
app.post('/api/customers', async (req, res) => {
    try {
        const { stationId, name, phone, coupons } = req.body;
        const cleanPhone = String(phone || '').trim();
        const cleanName = String(name || '').trim();
        const amount = parseInt(coupons) || 0;
        const sId = parseInt(stationId) || 1;

        if (!cleanPhone || !cleanName) {
            return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
        }

        // البحث إذا كان الزبون موجوداً مسبقاً
        const existing = await pool.query(
            'SELECT * FROM customers WHERE TRIM(phone) = $1 AND station_id = $2',
            [cleanPhone, sId]
        );

        let customer;
        if (existing.rows.length > 0) {
            // تحديث الرصيد للزبون الحالي
            const updated = await pool.query(
                'UPDATE customers SET coupons = coupons + $1, name = $2 WHERE id = $3 RETURNING *',
                [amount, cleanName, existing.rows[0].id]
            );
            customer = updated.rows[0];
        } else {
            // إضافة زبون جديد
            const inserted = await pool.query(
                'INSERT INTO customers (station_id, name, phone, coupons) VALUES ($1, $2, $3, $4) RETURNING *',
                [sId, cleanName, cleanPhone, amount]
            );
            customer = inserted.rows[0];
        }

        // تسجيل حركة الشحن في السجل
        await pool.query(
            'INSERT INTO transactions (station_id, customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5, $6)',
            [sId, customer.phone, customer.name, 'شحن', amount, 'المحطة']
        );

        res.json({
            success: true,
            message: `تم شحن ${amount} كوبون للزبون ${customer.name} بنجاح`,
            customer
        });
    } catch (err) {
        console.error('Error adding/recharging customer:', err.message);
        res.status(500).json({ success: false, message: 'خطأ أثناء شحن الرصيد' });
    }
});

// ==================== 3. مسارات الموزعين والخصم (DRIVERS & DEDUCT) ====================

// إضافة موزع جديد للمحطة
app.post('/api/drivers', async (req, res) => {
    try {
        const { stationId, name, phone, password } = req.body;
        const sId = parseInt(stationId) || 1;
        const cleanName = String(name || '').trim();
        const cleanPhone = String(phone || '').trim();
        const cleanPass = String(password || '').trim();

        if (!cleanName || !cleanPhone || !cleanPass) {
            return res.status(400).json({ success: false, message: 'يرجى ملء جميع الحقول' });
        }

        await pool.query(
            'INSERT INTO drivers (station_id, name, phone, password) VALUES ($1, $2, $3, $4)',
            [sId, cleanName, cleanPhone, cleanPass]
        );

        res.json({ success: true, message: 'تمت إضافة الموزع بنجاح' });
    } catch (err) {
        console.error('Error adding driver:', err.message);
        if (err.code === '23505') {
            return res.status(400).json({ success: false, message: 'رقم هاتف الموزع مستخدم بالفعل' });
        }
        res.status(500).json({ success: false, message: 'خطأ أثناء إضافة الموزع' });
    }
});

// خصم كوبونات من الزبون (بواسطة الموزع) - دعم تحديد الكمية
app.post('/api/deduct', async (req, res) => {
    try {
        const { driverPhone, driverPassword, customerPhone, amount } = req.body;
        const dPhone = String(driverPhone || '').trim();
        const dPass = String(driverPassword || '').trim();
        const cPhone = String(customerPhone || '').trim();
        const deductAmount = Math.max(1, parseInt(amount) || 1);

        // 1. التحقق من الموزع
        const driverRes = await pool.query(
            'SELECT * FROM drivers WHERE TRIM(phone) = $1 AND TRIM(password) = $2',
            [dPhone, dPass]
        );

        if (driverRes.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'بيانات دخول الموزع غير صحيحة' });
        }

        const driver = driverRes.rows[0];

        // 2. التحقق من الزبون ورصيده
        const customerRes = await pool.query(
            'SELECT * FROM customers WHERE TRIM(phone) = $1',
            [cPhone]
        );

        if (customerRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'الزبون غير موجود' });
        }

        const customer = customerRes.rows[0];

        if (customer.coupons < deductAmount) {
            return res.status(400).json({ 
                success: false, 
                message: `رصيد الزبون لا يكفي. الرصيد الحالي: ${customer.coupons} كوبون` 
            });
        }

        // 3. خصم الكوبونات
        const updatedCustomer = await pool.query(
            'UPDATE customers SET coupons = coupons - $1 WHERE id = $2 RETURNING *',
            [deductAmount, customer.id]
        );

        // 4. تسجيل عملية الخصم
        await pool.query(
            'INSERT INTO transactions (station_id, customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5, $6)',
            [driver.station_id || customer.station_id || 1, customer.phone, customer.name, 'خصم', deductAmount, driver.name]
        );

        res.json({
            success: true,
            message: `تم خصم ${deductAmount} كوبون بنجاح. الرصيد المتبقي للزبون (${customer.name}): ${updatedCustomer.rows[0].coupons}`
        });

    } catch (err) {
        console.error('Error deducting coupon:', err.message);
        res.status(500).json({ success: false, message: 'خطأ أثناء الخصم' });
    }
});

// تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});