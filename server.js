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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'karam-uploads';

if (!ADMIN_PASSWORD) throw new Error('Missing ADMIN_PASSWORD environment variable');
if (!process.env.SESSION_SECRET) throw new Error('Missing SESSION_SECRET environment variable');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing Supabase server environment variables');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'karam.sid', secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
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

app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').eq('active', true).order('id', { ascending: false });
  if (error) return res.status(500).json({ error: 'تعذر تحميل المنتجات' });
  res.json(data || []);
});

app.post('/api/orders', upload.single('file'), async (req, res) => {
  try {
    const { customer, phone, service, copies, print_type, notes } = req.body;
    if (!customer || !phone || !service) return res.status(400).json({ error: 'من فضلك أدخل الاسم ورقم الهاتف ونوع الخدمة' });
    let fileName = null, filePath = null;
    if (req.file) {
      fileName = safeFileName(req.file.originalname);
      filePath = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${fileName}`;
      const { error: storageError } = await supabase.storage.from(BUCKET).upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream', upsert: false
      });
      if (storageError) return res.status(500).json({ error: 'تعذر رفع الملف. حاول مرة أخرى أو تواصل معنا عبر واتساب.' });
    }
    const parsedCopies = Math.max(1, Math.min(500, Number.parseInt(copies || '1', 10) || 1));
    const { data, error } = await supabase.from('orders').insert([{
      customer: String(customer).trim().slice(0, 100), phone: String(phone).trim().slice(0, 20),
      service: String(service).trim().slice(0, 200), file_name: fileName, file_path: filePath,
      print_type: print_type ? String(print_type).slice(0, 100) : null,
      copies: parsedCopies, notes: notes ? String(notes).slice(0, 2000) : null
    }]).select('id').single();
    if (error) {
      if (filePath) await supabase.storage.from(BUCKET).remove([filePath]);
      return res.status(500).json({ error: 'تعذر حفظ الطلب. حاول مرة أخرى.' });
    }
    res.json({ ok: true, id: data.id });
  } catch (error) { res.status(500).json({ error: 'حدث خطأ أثناء إرسال الطلب' }); }
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  req.session.admin = true; res.json({ ok: true });
});
app.post('/api/admin/logout', adminOnly, (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/admin/orders', adminOnly, async (req, res) => {
  const { data, error } = await supabase.from('orders').select('*').order('id', { ascending: false }).limit(300);
  if (error) return res.status(500).json({ error: 'تعذر تحميل الطلبات' });
  const orders = await Promise.all((data || []).map(async order => {
    let fileUrl = null;
    if (order.file_path) {
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(order.file_path, 600);
      fileUrl = signed?.signedUrl || null;
    }
    return { ...order, stored_file: fileUrl, file_url: fileUrl };
  }));
  res.json(orders);
});

app.patch('/api/admin/orders/:id', adminOnly, async (req, res) => {
  const allowed = ['جديد', 'قيد التنفيذ', 'تم', 'ملغي'];
  const status = String(req.body.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'حالة الطلب غير صحيحة' });
  const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'تعذر تحديث الطلب' });
  res.json({ ok: true });
});

app.post('/api/admin/products', adminOnly, async (req, res) => {
  const { name, description, price, category } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم المنتج مطلوب' });
  const { data, error } = await supabase.from('products').insert([{
    name: String(name).trim(), description: description || '', price: price || '',
    category: category || 'أدوات مدرسية', active: true
  }]).select('*').single();
  if (error) return res.status(500).json({ error: 'تعذر إضافة المنتج' });
  res.json({ ok: true, product: data });
});
app.patch('/api/admin/products/:id', adminOnly, async (req, res) => {
  const { name, description, price, category, active } = req.body, update = {};
  if (name !== undefined) update.name = String(name).trim();
  if (description !== undefined) update.description = String(description);
  if (price !== undefined) update.price = String(price);
  if (category !== undefined) update.category = String(category);
  if (active !== undefined) update.active = Boolean(active);
  const { error } = await supabase.from('products').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'تعذر تعديل المنتج' });
  res.json({ ok: true });
});
app.delete('/api/admin/products/:id', adminOnly, async (req, res) => {
  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'تعذر حذف المنتج' });
  res.json({ ok: true });
});
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'الحد الأقصى لحجم الملف 15 ميجابايت' });
  res.status(400).json({ error: err.message || 'حدث خطأ في الطلب' });
});
app.listen(PORT, () => console.log(`Karam Library running on port ${PORT}`));
