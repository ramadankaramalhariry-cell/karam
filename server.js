const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(dataDir, {recursive:true}); fs.mkdirSync(uploadDir, {recursive:true});
const db = new Database(path.join(dataDir, 'karam.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL, phone TEXT NOT NULL,
 service TEXT NOT NULL, file_name TEXT, stored_file TEXT, copies INTEGER DEFAULT 1,
 print_type TEXT, notes TEXT, status TEXT DEFAULT 'جديد', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '',
 price TEXT DEFAULT 'اسأل عن السعر', category TEXT DEFAULT 'مستلزمات مدرسية', active INTEGER DEFAULT 1
);
`);
if (db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) {
 const ins = db.prepare('INSERT INTO products(name,description,price,category) VALUES(?,?,?,?)');
 [
 ['ورق تصوير A4','ورق تصوير وطباعة','اسأل عن السعر','ورق وطباعة'],
 ['أقلام وأدوات مدرسية','مستلزمات الدراسة اليومية','اسأل عن السعر','أدوات مدرسية'],
 ['ورق ملون','ألوان ومقاسات متنوعة','اسأل عن السعر','ورق وطباعة'],
 ['كشاكيل وكراسات','كراسات وكشاكيل مدرسية','اسأل عن السعر','أدوات مدرسية'],
 ['ملفات وحافظات','حفظ وتنظيم الأوراق','اسأل عن السعر','مستلزمات مكتبية'],
 ['كتب خارجية','اطلب الكتب الخارجية واستلمها من المكتبة','حسب الكتاب','كتب']
 ].forEach(x=>ins.run(...x));
}
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({secret:process.env.SESSION_SECRET || 'replace-this-session-secret',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000}}));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname,'public')));
const storage = multer.diskStorage({destination:(req,file,cb)=>cb(null,uploadDir),filename:(req,file,cb)=>cb(null,Date.now()+'-'+file.originalname.replace(/[^\w.\-\u0600-\u06FF]/g,'_'))});
const upload = multer({storage,limits:{fileSize:15*1024*1024},fileFilter:(req,file,cb)=>{const ok=/\.(pdf|doc|docx|jpg|jpeg|png|xlsx|xls)$/i.test(file.originalname);cb(ok?null:new Error('نوع الملف غير مسموح'),ok);}});
const adminOnly=(req,res,next)=>req.session.admin?next():res.status(401).json({error:'يلزم تسجيل دخول المدير'});
app.get('/api/products',(req,res)=>res.json(db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id DESC').all()));
app.post('/api/orders',upload.single('file'),(req,res)=>{
 const {customer,phone,service,copies,printType,notes,fileName}=req.body;
 if(!customer||!phone||!service) return res.status(400).json({error:'يرجى إدخال الاسم ورقم الهاتف ونوع الخدمة'});
 const result=db.prepare('INSERT INTO orders(customer,phone,service,file_name,stored_file,copies,print_type,notes) VALUES(?,?,?,?,?,?,?,?)').run(customer,phone,service,fileName||'',req.file?req.file.filename:'',Math.max(1,Math.min(500,Number(copies)||1)),printType||'',notes||'');
 res.json({ok:true,id:result.lastInsertRowid});
});
app.post('/api/admin/login',(req,res)=>{if(req.body.password===ADMIN_PASSWORD){req.session.admin=true;return res.json({ok:true});}res.status(403).json({error:'كلمة المرور غير صحيحة'});});
app.post('/api/admin/logout',adminOnly,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/orders',adminOnly,(req,res)=>res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all()));
app.patch('/api/admin/orders/:id',adminOnly,(req,res)=>{const allowed=['جديد','قيد التنفيذ','جاهز للاستلام','تم التسليم','ملغي'];if(!allowed.includes(req.body.status))return res.status(400).json({error:'حالة غير صحيحة'});db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status,req.params.id);res.json({ok:true});});
app.post('/api/admin/products',adminOnly,(req,res)=>{const {name,description,price,category}=req.body;if(!name)return res.status(400).json({error:'اسم المنتج مطلوب'});const r=db.prepare('INSERT INTO products(name,description,price,category) VALUES(?,?,?,?)').run(name,description||'',price||'اسأل عن السعر',category||'مستلزمات مكتبية');res.json({ok:true,id:r.lastInsertRowid});});
app.delete('/api/admin/products/:id',adminOnly,(req,res)=>{db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id);res.json({ok:true});});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>res.status(400).json({error:err.message||'حدث خطأ'}));
app.listen(PORT,()=>console.log(`Karam Library running on port ${PORT}`));
