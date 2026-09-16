const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '8669028832:AAFD9RISfvSXGk5P0NtKsYaX2klsMUFOtLc';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://family_shop_db_user:qURGJOCdUY9V1xGqc8aS5MPMTbQGtTA5@dpg-dakqabe7bikc73dalrvg-a/family_shop_db';

const ADMIN_IDS = ['8094090200', '1657660247'];

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Статические файлы
app.use(express.static(path.join(__dirname)));

function cleanTelegramText(v) {
  return String(v || '')
    .replace(/#[^\s#]+/g, '')
    .replace(/\b(карго|cargo)\b/gi, '')
    .replace(/\s*[|•·]+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function inferCategory(name, desc) {
  const s = (String(name || '') + ' ' + String(desc || '')).toLowerCase();
  if (/(дет|детский|детская|детское|детские|ребен|ребён|малыш|малышка|для мальчика|для девочки)/i.test(s)) {
    return 'kids';
  }
  if (/(муж|мужской|мужская|мужское|мужские|парень|мужчин)/i.test(s)) {
    return 'men';
  }
  return 'women';
}

/* =========================
   DATABASE INIT
========================= */
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS family_shop_products (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        price NUMERIC NOT NULL DEFAULT 0,
        img TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('БД успешно инициализирована');
  } catch (e) {
    console.error('Ошибка инициализации БД:', e);
  }
}

/* =========================
   ROUTES
========================= */

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Получить товары
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, category, name, price::float AS price, img, description AS desc
      FROM family_shop_products
      ORDER BY created_at DESC
    `);
    res.json({ products: rows });
  } catch (e) {
    console.error('Get products error:', e);
    res.status(500).json({ error: 'Не удалось загрузить товары' });
  }
});

// Добавить товар
app.post('/api/products', async (req, res) => {
  try {
    const body = req.body || {};
    const name = cleanTelegramText(body.name || 'Товар');
    const desc = cleanTelegramText(body.desc || body.description || '');
    const price = Number(body.price) || 0;
    const img = String(body.img || '').trim();
    const category = body.category || inferCategory(name, desc);

    if (!name || !img) {
      return res.status(400).json({ error: 'Заполните имя и ссылку на фото' });
    }

    const id = 'custom-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');

    const { rows } = await pool.query(
      `INSERT INTO family_shop_products (id, category, name, price, img, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, category, name, price::float AS price, img, description AS desc`,
      [id, category, name, price, img, desc]
    );

    res.json({ ok: true, product: rows[0] });
  } catch (e) {
    console.error('Add product error:', e);
    res.status(500).json({ error: e.message || 'Ошибка сервера при добавлении' });
  }
});

// Удалить товар
app.delete('/api/products/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM family_shop_products WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка при удалении' });
  }
});

// Проверка здоровья
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM family_shop_products`);
    res.json({ ok: true, products: result.rows[0].count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Любой остальной запрос отдаёт index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
  });
});
