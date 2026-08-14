const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// إعداد الاتصال بقاعدة بيانات Supabase / PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ============================================================
// إعدادات Twilio لإرسال إشعارات الواتساب
// ============================================================
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// دالة تحويل أرقام الهواتف للصيغة الدولية للأردن تلقائياً (+962)
function formatJordanPhone(phone) {
    let clean = String(phone || '').trim();
    if (clean.startsWith('0')) {
        clean = '+9620' + clean.substring(1);
    } else if (!clean.startsWith('+')) {
        clean = '+9620' + clean;
    }
    return clean;
}

// دالة إرسال إشعارات الواتساب
async function sendWhatsAppNotification(toPhone, message) {
    try {
        if (!accountSid || !authToken) {
            console.log('Twilio credentials missing, notification skipped.');
            return;
        }
        const formattedPhone = formatJordanPhone(toPhone);
        await client.messages.create({
            from: 'whatsapp:+14155238886', // رقم Sandbox الافتراضي لـ Twilio
            to: `whatsapp:${formattedPhone}`,
            body: message
        });
        console.log(`WhatsApp notification sent to ${formattedPhone}`);
    } catch (err) {
        console.error('Twilio WhatsApp Error:', err.message);
    }
}

// توجيهات الصفحة لشاشة الخصم/الموزع
app.get('/deduct', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'deduct.html'));
});

app.get('/driver.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'deduct.html'));
});

// توجيه صفحة الزبون
app.get('/customer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer.html'));
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

// إعادة تعيين / تغيير كلمة مرور المحطة
app.post('/api/station/reset-password', async (req, res) => {
    try {
        const { stationId, newPassword } = req.body;
        const sId = parseInt(stationId);
        const nPass = String(newPassword || '').trim();

        if (!sId || !nPass) {
            return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
        }

        await pool.query(
            'UPDATE stations SET password = $1 WHERE id = $2',
            [nPass, sId]
        );

        res.json({ success: true, message: 'تم تحديث كلمة مرور المحطة بنجاح' });
    } catch (err) {
        console.error('Error resetting station password:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر أثناء تحديث كلمة المرور' });
    }
});

// جلب إحصائيات المحطة المحددة فقط
app.get('/api/station/:stationId/stats', async (req, res) => {
    try {
        const { stationId } = req.params;

        const rechargedRes = await pool.query(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE station_id = $1 AND action_type = 'شحن'",
            [stationId]
        );

        const deductedRes = await pool.query(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE station_id = $1 AND action_type = 'خصم'",
            [stationId]
        );

        const balanceRes = await pool.query(
            'SELECT COALESCE(SUM(coupons), 0) AS total FROM customers WHERE station_id = $1',
            [stationId]
        );

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

// جلب سجل حركات المحطة المحددة فقط
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

// جلب خلاصة وأرصدة زبائن المحطة
app.get('/api/station/:stationId/customers-summary', async (req, res) => {
    try {
        const { stationId } = req.params;
        const result = await pool.query(
            'SELECT * FROM customers WHERE station_id = $1 ORDER BY id DESC',
            [stationId]
        );
        res.json({ success: true, customers: result.rows });
    } catch (err) {
        console.error('Error fetching customers summary:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في جلب قائمة الزبائن' });
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

// جلب سجل حركات زبون معين عبر رقم الهاتف (جديد)
app.get('/api/customer/history/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const cleanPhone = String(phone || '').trim();

        const result = await pool.query(
            'SELECT action_type, amount, created_at FROM transactions WHERE TRIM(customer_phone) = $1 ORDER BY created_at DESC LIMIT 15',
            [cleanPhone]
        );

        res.json({ success: true, history: result.rows });
    } catch (err) {
        console.error('Error fetching customer history:', err.message);
        res.status(500).json({ success: false, message: 'خطأ أثناء جلب السجل' });
    }
});

// إضافة أو شحن رصيد زبون محدد بمحطته الحالية
app.post('/api/customers', async (req, res) => {
    try {
        const { stationId, name, phone, coupons } = req.body;
        const cleanPhone = String(phone || '').trim();
        const cleanName = String(name || '').trim();
        const amount = parseInt(coupons) || 0;
        const sId = parseInt(stationId);

        if (!sId || !cleanPhone || !cleanName) {
            return res.status(400).json({ success: false, message: 'بيانات غير مكتملة أو معرف المحطة مفقود' });
        }

        const existing = await pool.query(
            'SELECT * FROM customers WHERE TRIM(phone) = $1 AND station_id = $2',
            [cleanPhone, sId]
        );

        let customer;
        if (existing.rows.length > 0) {
            const updated = await pool.query(
                'UPDATE customers SET coupons = coupons + $1, name = $2 WHERE id = $3 RETURNING *',
                [amount, cleanName, existing.rows[0].id]
            );
            customer = updated.rows[0];
        } else {
            const inserted = await pool.query(
                'INSERT INTO customers (station_id, name, phone, coupons) VALUES ($1, $2, $3, $4) RETURNING *',
                [sId, cleanName, cleanPhone, amount]
            );
            customer = inserted.rows[0];
        }

        await pool.query(
            'INSERT INTO transactions (station_id, customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5, $6)',
            [sId, customer.phone, customer.name, 'شحن', amount, 'المحطة']
        );

        const rechargeMsg = `مرحباً ${customer.name}، تم شحن ${amount} كوبون لحسابك بنجاح. رصيدك الحالي هو: ${customer.coupons} كوبون.`;
        sendWhatsAppNotification(customer.phone, rechargeMsg);

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

// ==================== 3. مسارات الموزعين والخصم المخصص ====================

// إضافة موزع جديد للمحطة
app.post('/api/drivers', async (req, res) => {
    try {
        const { stationId, name, phone, password } = req.body;
        const sId = parseInt(stationId);
        const cleanName = String(name || '').trim();
        const cleanPhone = String(phone || '').trim();
        const cleanPass = String(password || '').trim();

        if (!sId || !cleanName || !cleanPhone || !cleanPass) {
            return res.status(400).json({ success: false, message: 'يرجى ملء جميع الحقول المطلوبة' });
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

// إعادة تعيين كلمة مرور الموزع
app.post('/api/driver/reset-password', async (req, res) => {
    try {
        const { stationId, driverPhone, newPassword } = req.body;
        const sId = parseInt(stationId);
        const dPhone = String(driverPhone || '').trim();
        const nPass = String(newPassword || '').trim();

        if (!sId || !dPhone || !nPass) {
            return res.status(400).json({ success: false, message: 'يرجى إدخال رقم هاتف الموزع وكلمة المرور الجديدة' });
        }

        const result = await pool.query(
            'UPDATE drivers SET password = $1 WHERE TRIM(phone) = $2 AND station_id = $3',
            [nPass, dPhone, sId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'لم يتم العثور على موزع بهذا الرقم في محطتك' });
        }

        res.json({ success: true, message: 'تم تحديث كلمة مرور الموزع بنجاح' });
    } catch (err) {
        console.error('Error resetting driver password:', err.message);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر أثناء تحديث كلمة المرور' });
    }
});

// خصم كوبونات من الزبون
app.post('/api/deduct', async (req, res) => {
    try {
        const { driverPhone, driverPassword, customerPhone, amount } = req.body;
        const dPhone = String(driverPhone || '').trim();
        const dPass = String(driverPassword || '').trim();
        const cPhone = String(customerPhone || '').trim();
        const deductAmount = Math.max(1, parseInt(amount) || 1);

        const driverRes = await pool.query(
            'SELECT * FROM drivers WHERE TRIM(phone) = $1 AND TRIM(password) = $2',
            [dPhone, dPass]
        );

        if (driverRes.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'بيانات دخول الموزع غير صحيحة' });
        }

        const driver = driverRes.rows[0];

        const customerRes = await pool.query(
            'SELECT * FROM customers WHERE TRIM(phone) = $1 AND station_id = $2',
            [cPhone, driver.station_id]
        );

        if (customerRes.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'الزبون غير موجود أو غير مسجل لدى محطة هذا الموزع' 
            });
        }

        const customer = customerRes.rows[0];

        if (customer.coupons < deductAmount) {
            return res.status(400).json({ 
                success: false, 
                message: `رصيد الزبون لا يكفي. الرصيد الحالي: ${customer.coupons} كوبون` 
            });
        }

        const updatedCustomer = await pool.query(
            'UPDATE customers SET coupons = coupons - $1 WHERE id = $2 RETURNING *',
            [deductAmount, customer.id]
        );

        await pool.query(
            'INSERT INTO transactions (station_id, customer_phone, customer_name, action_type, amount, driver_name) VALUES ($1, $2, $3, $4, $5, $6)',
            [driver.station_id, customer.phone, customer.name, 'خصم', deductAmount, driver.name]
        );

        const deductMsg = `مرحباً ${customer.name}، تم خصم ${deductAmount} كوبون بواسطة الموزع (${driver.name}). الرصيد المتبقي لك هو: ${updatedCustomer.rows[0].coupons} كوبون.`;
        sendWhatsAppNotification(customer.phone, deductMsg);

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