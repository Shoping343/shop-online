'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_IDS = new Set(['8094090200', '1657660247']);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      price NUMERIC NOT NULL DEFAULT 0,
      img TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shop_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT,
      telegram_username TEXT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      items JSONB NOT NULL,
      total NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const defaults = {
    site_title: 'Family shop',
    site_subtitle: 'Одежда для всей семьи · с большой любовью',
    women: '👩 Женское',
    men: '👨 Мужское',
    kids: '👶 Детское',
    support_title: 'Нужна помощь с размером или заказом?',
    support_text: 'Напишите владельцу или менеджеру в Telegram.',
    price_note: 'Цены указаны в формате: товар + карго'
  };
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      'INSERT INTO shop_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',
      [key, value]
    );
  }
}

function getInitData(req) {
  return req.get('X-Telegram-Init-Data') || req.body?.initData || '';
}

function validateTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (expected.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86400) return null;
    const user = params.get('user');
    return user ? JSON.parse(user) : null;
  } catch (_) {
    return null;
  }
}

function adminAuth(req, res, next) {
  const user = validateTelegramInitData(getInitData(req));
  if (!user || !ADMIN_IDS.has(String(user.id))) {
    return res.status(403).json({ error: 'Доступ разрешён только двум администраторам Telegram.' });
  }
  req.telegramUser = user;
  next();
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c]));
}

async function sendTelegramMessage(text) {
  if (!BOT_TOKEN) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN не задан в Render' };
  const results = [];
  for (const chatId of ADMIN_IDS) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      });
      const data = await r.json();
      results.push({ chatId, ok: !!data.ok, error: data.ok ? null : data.description });
    } catch (e) {
      results.push({ chatId, ok: false, error: e.message });
    }
  }
  return { ok: results.every(x => x.ok), results };
}

app.get('/api/me', (req, res) => {
  const user = validateTelegramInitData(getInitData(req));
  res.json({ admin: !!user && ADMIN_IDS.has(String(user.id)), user: user ? { id: user.id, username: user.username || '' } : null });
});

app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, category, name, price, img, description AS desc FROM products ORDER BY created_at DESC');
    res.json({ products: rows.map(r => ({ ...r, price: Number(r.price) })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось загрузить каталог.' });
  }
});

app.post('/api/products', adminAuth, async (req, res) => {
  const { category, name, price, img, desc } = req.body || {};
  if (!['women','men','kids'].includes(category) || !String(name || '').trim() || !Number.isFinite(Number(price)) || Number(price) < 0 || !String(img || '').trim()) {
    return res.status(400).json({ error: 'Заполните категорию, название, цену и фото.' });
  }
  const id = `custom-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    const { rows } = await pool.query(
      'INSERT INTO products(id,category,name,price,img,description) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,category,name,price,img,description AS desc',
      [id, category, String(name).trim(), Number(price), String(img).trim(), String(desc || '').trim()]
    );
    const product = { ...rows[0], price: Number(rows[0].price) };
    res.json({ product });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось добавить товар.' });
  }
});

app.delete('/api/products/:id', adminAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ error: 'Не указан ID товара.' });
    try {
    await pool.query('DELETE FROM products WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось удалить товар.' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key,value FROM shop_settings');
    res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось загрузить настройки.' });
  }
});

app.put('/api/settings', adminAuth, async (req, res) => {
  const allowed = ['site_title','site_subtitle','women','men','kids','support_title','support_text','price_note'];
  const input = req.body?.settings || {};
  try {
    for (const key of allowed) {
      const value = String(input[key] ?? '').trim();
      if (value) await pool.query('INSERT INTO shop_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
    }
    const { rows } = await pool.query('SELECT key,value FROM shop_settings');
    res.json({ ok: true, settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось сохранить меню.' });
  }
});

app.post('/api/orders', async (req, res) => {
  const { name, phone, address, items, total } = req.body || {};
  if (!String(name || '').trim() || !String(phone || '').trim() || !String(address || '').trim() || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Заполните имя, телефон, адрес и корзину.' });
  }
  const tgUser = validateTelegramInitData(getInitData(req));
  const safeItems = items.map(x => ({ id: String(x.id || ''), name: String(x.name || ''), qty: Number(x.qty) || 0, price: Number(x.price) || 0 }));
  const numericTotal = Number(total) || safeItems.reduce((s, x) => s + x.qty * x.price, 0);
  try {
    const saved = await pool.query(
      'INSERT INTO orders(telegram_user_id,telegram_username,name,phone,address,items,total) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at',
      [tgUser?.id || null, tgUser?.username || null, String(name).trim(), String(phone).trim(), String(address).trim(), JSON.stringify(safeItems), numericTotal]
    );
    const orderId = saved.rows[0].id;
    const lines = safeItems.map(x => `• ${htmlEscape(x.name)} × ${x.qty} — ${new Intl.NumberFormat('ru-RU').format(x.qty * x.price)} сум`).join('\n');
    const tgName = tgUser ? `\n🆔 Telegram ID: ${htmlEscape(tgUser.id)}${tgUser.username ? ` (@${htmlEscape(tgUser.username)})` : ''}` : '';
    const message = `🛍️ <b>НОВЫЙ ЗАКАЗ #${orderId}</b>\n\n👤 <b>Имя:</b> ${htmlEscape(name)}\n📞 <b>Телефон:</b> ${htmlEscape(phone)}\n📍 <b>Адрес:</b> ${htmlEscape(address)}${tgName}\n\n${lines}\n\n💰 <b>Итого:</b> ${new Intl.NumberFormat('ru-RU').format(numericTotal)} сум + карго`;
    const telegram = await sendTelegramMessage(message);
    res.json({ ok: true, order_id: orderId, telegram_sent: telegram.ok, telegram });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Заказ не удалось сохранить.' });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'family_shop_fixed.html')));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Family Shop listening on ${PORT}`));
}).catch(err => {
  console.error('Database init failed:', err);
  process.exit(1);
});
