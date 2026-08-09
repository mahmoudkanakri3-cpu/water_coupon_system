const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors'); // إضافة cors لتفادي مشاكل الاتصال

const app = express();
const PORT = process.env.PORT || 3000;

// تفعيل CORS و Express Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// الاتصال بقاعدة البيانات بشكل متزامن
const db = new Database(path.join(__dirname, 'database.sqlite'));

// تهيئة الجداول عند بدء التشغيل
function initDB() {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS stations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT DEFAULT 'محطة المياه',
                phone TEXT UNIQUE,
                password TEXT
            );

            CREATE TABLE IF NOT EXISTS drivers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                phone TEXT UNIQUE,
                password TEXT
            );

            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                phone TEXT UNIQUE,
                coupons_balance INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_phone TEXT,
                customer_name TEXT,
                driver_name TEXT,
                action_type TEXT,
                amount INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // حساب محطة افتراضي
        const admin = db.prepare('SELECT * FROM stations WHERE phone = ?').get('0700000000');
        if (!admin) {
            db.prepare('INSERT INTO stations (name, phone, password) VALUES (?, ?, ?)').run('المحطة الرئيسية', '0700000000', 'admin123');
        }

        console.log("قاعدة البيانات جاهزة!");
    } catch (err) {
        console.error("خطأ في قاعدة البيانات:", err);
        process.exit(1);
    }
}

initDB();

// تسجيل دخول المحطة
app.post('/api/station/login', (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone || !password) {
            return res.json({ success: false, message: 'يرجى إدخال رقم الهاتف وكلمة المرور' });
        }

        const station = db.prepare('SELECT * FROM stations WHERE phone = ? AND password = ?').get(String(phone).trim(), String(password).trim());
        
        if (station) {
            res.json({ success: true, message: 'تم تسجيل الدخول بنجاح', station: { name: station.name } });
        } else {
            res.json({ success: false, message: 'بيانات دخول المحطة غير صحيحة' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// استعلام عن رصيد زبون
app.get('/api/customers/:phone', (req, res) => {
    try {
        const phone = req.params.phone ? req.params.phone.trim() : '';
        const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
        if (customer) {
            res.json({ success: true, customer });
        } else {
            res.json({ success: false, message: 'الزبون غير موجود' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// إضافة أو شحن رصيد زبون
app.post('/api/customers', (req, res) => {
    try {
        const { name, phone, coupons } = req.body;
        if (!phone) {
            return res.json({ success: false, message: 'رقم الهاتف مطلوب' });
        }

        const cleanPhone = String(phone).trim();
        const cleanName = name ? String(name).trim() : '';
        const numCoupons = parseInt(coupons, 10) || 0;

        let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(cleanPhone);

        if (customer) {
            const newBalance = customer.coupons_balance + numCoupons;
            const finalName = cleanName !== '' ? cleanName : customer.name;
            
            db.prepare('UPDATE customers SET name = ?, coupons_balance = ? WHERE phone = ?').run(finalName, newBalance, cleanPhone);
            db.prepare('INSERT INTO transactions (customer_phone, customer_name, driver_name, action_type, amount) VALUES (?, ?, ?, ?, ?)').run(cleanPhone, finalName, 'إدارة المحطة', 'شحن رصيد', numCoupons);

            return res.json({ success: true, message: `تم تحديث الحساب وشحن ${numCoupons} كوبون. الرصيد الجديد: ${newBalance}` });
        } else {
            db.prepare('INSERT INTO customers (name, phone, coupons_balance) VALUES (?, ?, ?)').run(cleanName, cleanPhone, numCoupons);
            db.prepare('INSERT INTO transactions (customer_phone, customer_name, driver_name, action_type, amount) VALUES (?, ?, ?, ?, ?)').run(cleanPhone, cleanName, 'إدارة المحطة', 'شحن جديد', numCoupons);

            return res.json({ success: true, message: 'تم إضافة الزبون وشحن الرصيد بنجاح!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// خصم كوبونات من قبل الموزع
app.post('/api/deduct-coupon', (req, res) => {
    try {
        const { driverPhone, driverPassword, customerPhone, count } = req.body;
        if (!driverPhone || !driverPassword || !customerPhone) {
            return res.json({ success: false, message: 'جميع البيانات مطلوبة' });
        }

        const deductAmount = parseInt(count, 10) || 1;

        const driver = db.prepare('SELECT * FROM drivers WHERE phone = ? AND password = ?').get(String(driverPhone).trim(), String(driverPassword).trim());
        if (!driver) {
            return res.json({ success: false, message: 'بيانات الموزع غير صحيحة' });
        }

        const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(String(customerPhone).trim());
        if (!customer) {
            return res.json({ success: false, message: 'حساب الزبون غير موجود' });
        }

        if (customer.coupons_balance < deductAmount) {
            return res.json({ success: false, message: `رصيد الزبون لا يكفي! المتبقي: ${customer.coupons_balance}` });
        }

        const newBalance = customer.coupons_balance - deductAmount;
        db.prepare('UPDATE customers SET coupons_balance = ? WHERE phone = ?').run(newBalance, customer.phone);
        db.prepare('INSERT INTO transactions (customer_phone, customer_name, driver_name, action_type, amount) VALUES (?, ?, ?, ?, ?)').run(customer.phone, customer.name, driver.name, 'خصم كوبون', deductAmount);

        res.json({ success: true, message: `تم خصم ${deductAmount} كوبون بنجاح. الرصيد المتبقي: ${newBalance}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// إضافة موزع جديد
app.post('/api/drivers', (req, res) => {
    try {
        const { name, phone, password } = req.body;
        if (!name || !phone || !password) {
            return res.json({ success: false, message: 'جميع بيانات الموزع مطلوبة' });
        }

        db.prepare('INSERT INTO drivers (name, phone, password) VALUES (?, ?, ?)').run(String(name).trim(), String(phone).trim(), String(password).trim());
        res.json({ success: true, message: 'تم إضافة الموزع بنجاح!' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'رقم الهاتف مستخدم مسبقاً للسائق' });
    }
});

// جلب سجل الحركات
app.get('/api/station/transactions', (req, res) => {
    try {
        const transactions = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50').all();
        res.json({ success: true, transactions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// جلب الإحصائيات الشاملة
app.get('/api/station/stats', (req, res) => {
    try {
        const recharged = db.prepare(`SELECT SUM(amount) as total FROM transactions WHERE action_type IN ('شحن رصيد', 'شحن جديد')`).get();
        const deducted = db.prepare(`SELECT SUM(amount) as total FROM transactions WHERE action_type = 'خصم كوبون'`).get();
        const totalBalance = db.prepare(`SELECT SUM(coupons_balance) as total FROM customers`).get();
        const driverStats = db.prepare(`
            SELECT driver_name, COUNT(*) as operations_count, SUM(amount) as total_deducted
            FROM transactions
            WHERE action_type = 'خصم كوبون'
            GROUP BY driver_name
        `).all();

        res.json({
            success: true,
            stats: {
                totalRecharged: recharged.total || 0,
                totalDeducted: deducted.total || 0,
                totalBalance: totalBalance.total || 0,
                driverStats: driverStats
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// إعادة توجيه كافة المسارات الأخرى لملف الصفحة الرئيسية
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});