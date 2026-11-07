# موقع مكتبة كرم – نسخة Supabase

هذه النسخة تحفظ طلبات العملاء في Supabase Database وترفع الملفات إلى Supabase Storage بدلاً من قرص Render المؤقت.

## قبل النشر
1. في Supabase افتح SQL Editor ثم New query، والصق محتوى `supabase/schema.sql` وشغّله مرة واحدة.
2. تأكد أن Storage bucket اسمه `karam-uploads` موجود، واجعله **Private** (Public bucket غير مطلوب).
3. في Supabase > Project Settings > API Keys أنشئ/انسخ **Secret key** الخاص بالخادم فقط. لا تستخدم Publishable key ولا تضع Secret key في ملفات الواجهة أو GitHub.
4. في Render أضف المتغيرات التالية:
   - `NODE_ENV` = `production`
   - `ADMIN_PASSWORD` = كلمة مرور طويلة وفريدة (12 حرفاً على الأقل)
   - `SESSION_SECRET` = قيمة عشوائية طويلة
   - `SUPABASE_URL` = Project URL من Supabase
   - `SUPABASE_SECRET_KEY` = Secret key من Supabase
   - `SUPABASE_BUCKET` = `karam-uploads`
5. Build command: `npm install`
6. Start command: `npm start`
7. استخدم خطة Render Free. قد ينام الموقع بعد عدم النشاط، وقد يستغرق أول فتح بعد النوم بعض الوقت. التخزين الدائم للطلبات والملفات يكون في Supabase.

## ملاحظات أمنية
- لا ترفع ملف `.env` أو مفاتيح Supabase السرية إلى GitHub.
- لا تجعل bucket عاماً؛ الخادم ينشئ روابط مؤقتة للملفات بعد دخول المدير.
- غيّر أي كلمة مرور أو مفتاح سبق ظهوره في لقطة شاشة.
- اختبر إرسال طلب تجريبي وظهوره في لوحة الإدارة قبل الإعلان عن الموقع.
