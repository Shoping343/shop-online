const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Connect a Render Postgres database to this service.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'family_shop_admin',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

async function initDb() {
  if (!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('women','men','kids')),
      name TEXT NOT NULL,
      price NUMERIC NOT NULL,
      img TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function send(res, data, status = 200) {
  res.status(status).json(data);
}
function requireAdmin(req, res, next) {
  if (!req.session.admin) return send(res, { ok: false, error: 'Требуется вход администратора.' }, 401);
  next();
}
function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}
function mapProduct(row) {
  return { id: row.id, category: row.category, name: row.name, price: Number(row.price), img: row.img, desc: row.description };
}

// Keep the existing index.html unchanged: it calls api.php?action=...
app.all('/api.php', async (req, res) => {
  try {
    const action = req.query.action || 'products';

    if (action === 'login' && req.method === 'POST') {
      const password = String(req.body?.password || '');
      if (!ADMIN_PASSWORD) return send(res, { ok: false, error: 'ADMIN_PASSWORD не настроен на сервере.' }, 500);
      const good = crypto.timingSafeEqual(crypto.createHash('sha256').update(password).digest(), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest());
      if (!good) return send(res, { ok: false, error: 'Неверный пароль.' }, 403);
      req.session.regenerate(err => {
        if (err) return send(res, { ok: false, error: 'Ошибка сессии.' }, 500);
        req.session.admin = true;
        send(res, { ok: true, admin: true });
      });
      return;
    }

    if (action === 'logout' && req.method === 'POST') {
      req.session.destroy(() => send(res, { ok: true }));
      return;
    }

    if (action === 'me' && req.method === 'GET') {
      return send(res, { ok: true, admin: !!req.session.admin });
    }

    if (!process.env.DATABASE_URL) return send(res, { ok: false, error: 'База данных не подключена.' }, 500);

    if (action === 'products' && req.method === 'GET') {
      const result = await pool.query('SELECT id, category, name, price, img, description FROM products ORDER BY created_at ASC');
      return send(res, { ok: true, products: result.rows.map(mapProduct) });
    }

    if (action === 'products' && req.method === 'POST') {
      if (!req.session.admin) return send(res, { ok: false, error: 'Требуется вход администратора.' }, 401);
      const category = clean(req.body?.category, 20);
      const name = clean(req.body?.name, 150);
      const img = clean(req.body?.img, 1000);
      const desc = clean(req.body?.desc, 300);
      const price = Number(req.body?.price);
      if (!['women','men','kids'].includes(category) || !name || !Number.isFinite(price) || price < 0 || !img || !desc) {
        return send(res, { ok: false, error: 'Заполните все поля корректно.' }, 422);
      }
      const id = 'custom-' + crypto.randomBytes(8).toString('hex');
      const result = await pool.query(
        'INSERT INTO products (id, category, name, price, img, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, category, name, price, img, description',
        [id, category, name, price, img, desc]
      );
      return send(res, { ok: true, product: mapProduct(result.rows[0]) });
    }

    if (action === 'products' && req.method === 'DELETE') {
      if (!req.session.admin) return send(res, { ok: false, error: 'Требуется вход администратора.' }, 401);
      const id = clean(req.query.id, 100);
      if (!id) return send(res, { ok: false, error: 'Не указан ID товара.' }, 400);
      const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
      if (!result.rowCount) return send(res, { ok: false, error: 'Товар не найден.' }, 404);
      return send(res, { ok: true, deleted: id });
    }

    return send(res, { ok: false, error: 'Неизвестный запрос.' }, 404);
  } catch (err) {
    console.error(err);
    return send(res, { ok: false, error: 'Ошибка сервера.' }, 500);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname)));

initDb()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Family Shop listening on ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
