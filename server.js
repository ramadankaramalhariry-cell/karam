const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'karam-uploads';

for (const [key, value] of Object.entries({ ADMIN_PASSWORD, SESSION_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY })) {
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
}
if (ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters long');

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(session({
  name: 'karam.sid', secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

const allowedExtensions = /\.(pdf|doc|docx|jpg|jpeg|png|xls|xlsx)$/i;
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => allowedExtensions.test(file.originalname)
    ? cb(null, true) : cb(new Error('نوع الملف غير مسموح. المسموح PDF وWord وExcel والصور.'))
});

app.use(express.static(path.join(__dirname, 'public')));
function adminOnly(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({ error: 'يجب تسجيل دخول الإدارة أولاً' });
  next();
}
function safeFileName(name) {
  return path.basename(name).replace(/[^\w.\-\u0600-\u06FF]/g, '_').slice(0, 120);
}
function text(value, max = 2000) { return String(value ?? '').trim().slice(0, max); }

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase.from('products').select('id,name,description,price,category,active,created_at').eq('active', true).order('id', { ascending: false });
  if (error) return res.status(500).json({ error: 'تعذر تحميل المنتجات' });
  res.json(data || []);
});

app.post('/api/orders', upload.single('file'), async (req, res) => {
  let uploadedPath = null;
  try {
    const customer = text(req.body.customer, 100);
    const phone = text(req.body.phone, 30);
    const service = text(req.body.service, 200);
    if (!customer || !phone || !service) return res.status(400).json({ error: 'من فضلك أدخل الاسم ورقم الهاتف ونوع الخدمة' });

    let fileName = null;
    if (req.file) {
      fileName = safeFileName(req.file.originalname);
      uploadedPath = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${fileName}`;
      const { error: storageError } = await supabase.storage.from(BUCKET).upload(uploadedPath, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream', upsert: false
      });
      if (storageError) return res.status(500).json({ error: 'تعذر رفع الملف. حاول مرة أخرى أو تواصل معنا عبر واتساب.' });
    }

    const parsedCopies = Math.max(1, Math.min(500, Number.parseInt(req.body.copies || '1', 10) || 1));
    const { data, error } = await supabase.from('orders').insert([{
      customer, phone, service, file_name: fileName, file_path: uploadedPath,
      copies: parsedCopies, print_type: text(req.body.printType, 100),
      notes: text(req.body.notes, 2000), status: 'جديد'
    }]).select('id').single();
    if (error) {
      if (uploadedPath) await supabase.storage.from(BUCKET).remove([uploadedPath]);
      return res.status(500).json({ error: 'تعذر حفظ الطلب. حاول مرة أخرى.' });
    }
    res.json({ ok: true, id: data.id });
  } catch (error) {
    if (uploadedPath) await supabase.storage.from(BUCKET).remove([uploadedPath]).catch(() => {});
    console.error('Order submission failed:', error.message);
    res.status(500).json({ error: 'حدث خطأ أثناء إرسال الطلب' });
  }
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  req.session.admin = true;
  res.json({ ok: true });
});
app.post('/api/admin/logout', adminOnly, (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/admin/orders', adminOnly, async (req, res) => {
  const { data, error } = await supabase.from('orders').select('*').order('id', { ascending: false }).limit(300);
  if (error) return res.status(500).json({ error: 'تعذر تحميل الطلبات' });
  const orders = await Promise.all((data || []).map(async order => {
    let fileUrl = null;
    if (order.file_path) {
      const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(order.file_path, 600);
      if (!signError) fileUrl = signed?.signedUrl || null;
    }
    return { ...order, stored_file: fileUrl, file_url: fileUrl };
  }));
  res.json(orders);
});

app.patch('/api/admin/orders/:id', adminOnly, async (req, res) => {
  const allowed = ['جديد', 'قيد التنفيذ', 'جاهز للاستلام', 'تم التسليم', 'ملغي'];
  const status = text(req.body.status, 50);
  if (!allowed.includes(status)) return res.status(400).json({ error: 'حالة الطلب غير صحيحة' });
  const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'تعذر تحديث الطلب' });
  res.json({ ok: true });
});

app.post('/api/admin/products', adminOnly, async (req, res) => {
  const name = text(req.body.name, 150);
  if (!name) return res.status(400).json({ error: 'اسم المنتج مطلوب' });
  const { data, error } = await supabase.from('products').insert([{
    name, description: text(req.body.description, 500), price: text(req.body.price, 100) || 'اسأل عن السعر',
    category: text(req.body.category, 100) || 'أدوات مدرسية', active: true
  }]).select('*').single();
  if (error) return res.status(500).json({ error: 'تعذر إضافة المنتج' });
  res.json({ ok: true, product: data });
});
app.patch('/api/admin/products/:id', adminOnly, async (req, res) => {
  const update = {};
  for (const key of ['name', 'description', 'price', 'category']) if (req.body[key] !== undefined) update[key] = text(req.body[key], key === 'description' ? 500 : 150);
  if (req.body.active !== undefined) update.active = Boolean(req.body.active);
  const { error } = await supabase.from('products').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'تعذر تعديل المنتج' });
  res.json({ ok: true });
});
app.delete('/api/admin/products/:id', adminOnly, async (req, res) => {
  const { error } = await supabase.from('products').update({ active: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'تعذر حذف المنتج' });
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'الحد الأقصى لحجم الملف 15 ميجابايت' });
  res.status(400).json({ error: err.message || 'حدث خطأ في الطلب' });
});

app.listen(PORT, () => console.log(`Karam Library running on port ${PORT}`));
