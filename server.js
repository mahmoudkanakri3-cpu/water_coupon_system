const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

let db;

async function initDB() {
    try {
        db = await open({
            filename: path.join(__dirname, 'database.sqlite'),
            driver: sqlite3.Database
        });

        await db.exec(`
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
        const admin = await db.get('SELECT * FROM stations WHERE phone = ?', ['0700000000']);
        if (!admin) {
            await db.run('INSERT INTO stations (name, phone, password) VALUES (?, ?, ?)', ['المحطة الرئيسية', '0700000000', 'admin123']);
        }

        console.log("قاعدة البيانات جاهزة!");
    } catch (err) {
        console.error("خطأ في قاعدة البيانات:", err);
        process.exit(1); // إيقاف التطبيق في حال فشل قاعدة البيانات
    }
}

// تسجيل دخول المحطة
app.post('/api/station/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone || !password) {
            return res.json({ success: false, message: 'يرجى إدخال رقم الهاتف وكلمة المرور' });
        }

        const station = await db.get('SELECT * FROM stations WHERE phone = ? AND password = ?', [String(phone).trim(), String(password).trim()]);
        
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
app.get('/api/customers/:phone', async (req, res) => {
    try {
        const phone = req.params.phone ? req.params.phone.trim() : '';
        const customer = await db.get('SELECT * FROM customers WHERE phone = ?', [phone]);
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
app.post('/api/customers', async (req, res) => {
    try {
        const { name, phone, coupons } = req.body;
        if (!phone) {
            return res.json({ success: false, message: 'رقم الهاتف مطلوب' });
        }

        const cleanPhone = String(phone).trim();
        const cleanName = name ? String(name).trim() : '';
        const numCoupons = parseInt(coupons, 10) || 0;

        let customer = await db.get('SELECT * FROM customers WHERE phone = ?', [cleanPhone]);

        if (customer) {
            const newBalance = customer.coupons_balance + numCoupons;
            const finalName = cleanName !== '' ? cleanName : customer.name;
            
            await db.run('UPDATE customers SET name = ?, coupons_balance = ? WHERE phone = ?', [finalName, newBalance, cleanPhone]);
            await db.run('INSERT INTO transactions (customer_phone, customer_name, driver_name, action_type, amount) VALUES (?, ?, ?, ?, ?)',
                [cleanPhone, finalName, 'إدارة المحطة', 'شحن رصيد', numCoupons]);

            return res.json({ success: true, message: `تم تحديث الحساب وشحن ${numCoupons} كوبون. الرصيد الجديد: ${newBalance}` });
        } else {
            await db.run('INSERT INTO customers (name, phone, coupons_balance) VALUES (?, ?, ?)', [cleanName, cleanPhone, numCoupons]);
            await db.run('INSERT INTO transactions (customer_phone, customer_name, driver_name, action_type, amount) VALUES (?, ?, ?, ?, ?)',
                [cleanPhone, cleanName, 'إدارة المحطة', 'شحن جديد', numCoupons]);

            return res.json({ success: true, message: 'تم إضافة الزبون وشحن الرصيد بنجاح!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// خصم كوبونات من قبل الموزع
app.post('/api/deduct-coupon', async (req, res) => {
    try {
        const { driverPhone, driverPassword, customerPhone, count } = req.body;
        if (!driverPhone || !driverPassword || !customerPhone) {
            return res.json({ success: false, message: 'جميع البيانات مطلوبة' });
        }

        const deductAmount = parseInt(count, 10) || 1;

        const driver = await db.get('SELECT * FROM drivers WHERE phone = ? AND password = ?', [String(driverPhone).trim(), String(driverPassword).trim()]);
        if (!driver) {
            return res.json({ success: false, message: 'بيانات الموزع غير صحيحة' });
        }

        const customer = await db.get('SELECT * FROM customers WHERE phone = ?', [String(customerPhone).trim()]);
        if (!customer) {
            return res.json({ success: false, message: 'حساب الزبون غير موجود' });
        }

        if (customer.coupons_balance < deductAmount) {
            return res.json({ success: false, message: `رصيد الزبون لا يكفي! المتبقي: ${customer.coupons_balance}` });
        }

        const newBalance = customer.coupons_balance - deductAmount;
        await db.run('UPDATE customers SET coupons_balance = ? WHERE phone = ?', [newBalance, customer.phone]);
        await db.run('INSERT INTO transactions (customer_phone, customer_name, driver_name, action_type, amount) VALUES (?, ?, ?, ?, ?)',
            [customer.phone, customer.name, driver.name, 'خصم كوبون', deductAmount]);

        res.json({ success: true, message: `تم خصم ${deductAmount} كوبون بنجاح. الرصيد المتبقي: ${newBalance}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// إضافة موزع جديد
app.post('/api/drivers', async (req, res) => {
    try {
        const { name, phone, password } = req.body;
        if (!name || !phone || !password) {
            return res.json({ success: false, message: 'جميع بيانات الموزع مطلوبة' });
        }

        await db.run('INSERT INTO drivers (name, phone, password) VALUES (?, ?, ?)', [String(name).trim(), String(phone).trim(), String(password).trim()]);
        res.json({ success: true, message: 'تم إضافة الموزع بنجاح!' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'رقم الهاتف مستخدم مسبقاً للسائق' });
    }
});

// جلب سجل الحركات
app.get('/api/station/transactions', async (req, res) => {
    try {
        const transactions = await db.all('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, transactions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// جلب الإحصائيات الشاملة
app.get('/api/station/stats', async (req, res) => {
    try {
        const recharged = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE action_type IN ('شحن رصيد', 'شحن جديد')`);
        const deducted = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE action_type = 'خصم كوبون'`);
        const totalBalance = await db.get(`SELECT SUM(coupons_balance) as total FROM customers`);
        const driverStats = await db.all(`
            SELECT driver_name, COUNT(*) as operations_count, SUM(amount) as total_deducted
            FROM transactions
            WHERE action_type = 'خصم كوبون'
            GROUP BY driver_name
        `);

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

// بدء السيرفر فقط بعد تجهيز قاعدة البيانات
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`السيرفر يعمل بنجاح على: http://localhost:${PORT}`);
    });
});