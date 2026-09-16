const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '8669028832:AAFD9RISfvSXGk5P0NtKsYaX2klsMUFOtLc';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://family_shop_db_user:qURGJOCdUY9V1xGqc8aS5MPMTbQGtTA5@dpg-dakqabe7bikc73dalrvg-a/family_shop_db';
const ADMIN_IDS = [8094090200, 1657660247];

if (!BOT_TOKEN) console.warn('WARNING: BOT_TOKEN is not set. Telegram notifications will not work.');
if (!DATABASE_URL) console.warn('WARNING: DATABASE_URL is not set.');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL) ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function esc(v) { return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatPrice(v) { return new Intl.NumberFormat('ru-RU').format(Number(v) || 0); }

async function initDb() {
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
    CREATE TABLE IF NOT EXISTS family_shop_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS family_shop_orders (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      telegram_user_id BIGINT,
      telegram_username TEXT,
      total NUMERIC NOT NULL DEFAULT 0,
      items JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calculated.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash))) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Math.abs(Date.now()/1000 - authDate) > 86400) return null;
    const user = params.get('user');
    return user ? JSON.parse(user) : null;
  } catch (_) { return null; }
}

function telegramUser(req) { return validateTelegramInitData(req.headers['x-telegram-init-data']); }
function requireAdmin(req, res, next) {
  const user = telegramUser(req);
  if (!user || !ADMIN_IDS.includes(Number(user.id))) return res.status(403).json({ error: 'Доступ запрещён.' });
  req.telegramUser = user;
  next();
}

async function telegram(method, payload) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан на сервере.');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const data = await r.json().catch(()=>({}));
  if (!r.ok || !data.ok) throw new Error(data.description || `Telegram API error: ${method}`);
  return data;
}

function orderText(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return [
    '🛍 <b>НОВЫЙ ЗАКАЗ</b>', '',
    `👤 <b>Имя:</b> ${esc(order.name)}`,
    `📞 <b>Телефон:</b> ${esc(order.phone)}`,
    `📍 <b>Адрес:</b> ${esc(order.address)}`,
    order.telegram_username ? `💬 <b>Telegram:</b> @${esc(order.telegram_username)}` : '',
    order.telegram_user_id ? `🆔 <b>Telegram ID:</b> ${esc(order.telegram_user_id)}` : '', '',
    '🛒 <b>Что заказали:</b>',
    ...items.map((x,i)=>`${i+1}. <b>${esc(x.name)}</b> — ${Number(x.qty)||0} шт. × ${formatPrice(x.price)} сум`), '',
    `💰 <b>Итого:</b> ${formatPrice(order.total)} сум + карго`, '',
    `🕐 ${new Date().toLocaleString('ru-RU',{timeZone:'Asia/Tashkent'})}`
  ].filter(Boolean).join('\n');
}

async function notifyAdmin(chatId, order) {
  await telegram('sendMessage',{chat_id:chatId,text:orderText(order),parse_mode:'HTML'});
  for (let i=0;i<order.items.length;i++) {
    const item=order.items[i];
    if (!item.img) continue;
    try {
      await telegram('sendPhoto',{chat_id:chatId,photo:item.img,caption:[`🛍 <b>${esc(item.name)}</b>`,`📦 <b>Количество:</b> ${Number(item.qty)||0} шт.`,`💰 <b>Цена:</b> ${formatPrice(item.price)} сум`,`🔢 <b>Позиция:</b> ${i+1}`].join('\n'),parse_mode:'HTML'});
    } catch (e) {
      await telegram('sendMessage',{chat_id:chatId,text:`⚠️ Фото товара «${esc(item.name)}» не удалось отправить автоматически. Проверьте, что в товаре указана прямая ссылка на изображение.`});
    }
  }
}

app.get('/api/products', async (_req,res)=>{
  try { const {rows}=await pool.query('SELECT id, category, name, price::float AS price, img, description AS desc FROM family_shop_products ORDER BY created_at ASC'); res.json({products:rows}); }
  catch(e){console.error(e);res.status(500).json({error:'Не удалось загрузить каталог.'});}
});

app.post('/api/products', requireAdmin, async (req,res)=>{
  try {
    const b=req.body||{};
    if(!b.name||!b.img||!b.desc||!b.category||!Number.isFinite(Number(b.price))||Number(b.price)<0) return res.status(400).json({error:'Заполните все поля товара.'});
    const id='custom-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
    const {rows}=await pool.query('INSERT INTO family_shop_products (id,category,name,price,img,description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,category,name,price::float AS price,img,description AS desc',[id,String(b.category),String(b.name).trim(),Number(b.price),String(b.img).trim(),String(b.desc).trim()]);
    res.json({ok:true,product:rows[0]});
  } catch(e){console.error(e);res.status(500).json({error:'Не удалось сохранить товар в базе данных.'});}
});

app.delete('/api/products/:id', requireAdmin, async (req,res)=>{
  try { const r=await pool.query('DELETE FROM family_shop_products WHERE id=$1',[req.params.id]); if(!r.rowCount)return res.status(404).json({error:'Товар не найден.'}); res.json({ok:true}); }
  catch(e){console.error(e);res.status(500).json({error:'Не удалось удалить товар из базы данных.'});}
});

const defaultSettings={site_title:'Family shop',site_subtitle:'Одежда для всей семьи · с большой любовью',women:'👩 Женское',men:'👨 Мужское',kids:'👶 Детское',support_title:'Нужна помощь с размером или заказом?',support_text:'Напишите владельцу или менеджеру в Telegram.',price_note:'Цены указаны в формате: товар + карго'};
app.get('/api/settings',async(_req,res)=>{try{const r=await pool.query("SELECT value FROM family_shop_settings WHERE key='main'");res.json({settings:r.rowCount?r.rows[0].value:defaultSettings});}catch(e){res.status(500).json({error:'Не удалось загрузить настройки.'});}});
app.put('/api/settings',requireAdmin,async(req,res)=>{try{const settings={...defaultSettings,...(req.body?.settings||{})};await pool.query("INSERT INTO family_shop_settings(key,value) VALUES('main',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",[settings]);res.json({ok:true,settings});}catch(e){console.error(e);res.status(500).json({error:'Не удалось сохранить настройки.'});}});

app.post('/api/orders',async(req,res)=>{
  try {
    const b=req.body||{};
    if(!b.name||!b.phone||!b.address||!Array.isArray(b.items)||!b.items.length) return res.status(400).json({error:'Заполните имя, телефон, адрес и корзину.'});
    const ids=b.items.map(x=>String(x.id));
    const {rows:products}=await pool.query('SELECT id,name,price::float AS price,img FROM family_shop_products WHERE id=ANY($1::text[])',[ids]);
    const byId=new Map(products.map(p=>[String(p.id),p]));
    const items=b.items.map(x=>{const p=byId.get(String(x.id));return p?{id:p.id,name:p.name,price:Number(p.price),img:p.img,qty:Number(x.qty)||0}:{name:String(x.name||'Товар'),price:Number(x.price)||0,img:x.img||'',qty:Number(x.qty)||0};}).filter(x=>x.qty>0);
    if(!items.length)return res.status(400).json({error:'В заказе нет доступных товаров.'});
    const total=items.reduce((s,x)=>s+x.price*x.qty,0);
    const order={name:String(b.name).trim(),phone:String(b.phone).trim(),address:String(b.address).trim(),telegram_user_id:b.telegram_user_id?Number(b.telegram_user_id):null,telegram_username:b.telegram_username?String(b.telegram_username):null,items,total};
    const saved=await pool.query('INSERT INTO family_shop_orders(name,phone,address,telegram_user_id,telegram_username,total,items) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[order.name,order.phone,order.address,order.telegram_user_id,order.telegram_username,total,JSON.stringify(items)]);
    const results=await Promise.allSettled(ADMIN_IDS.map(id=>notifyAdmin(id,{...order,id:saved.rows[0].id})));
    const sent=results.filter(x=>x.status==='fulfilled').length;
    if(!sent)return res.status(502).json({error:results[0].reason?.message||'Не удалось отправить заказ в Telegram.'});
    res.json({ok:true,orderId:saved.rows[0].id,telegramSent:sent});
  } catch(e){console.error('Order error:',e);res.status(500).json({error:e.message||'Ошибка сервера'});}
});

app.get('/api/health',async(_req,res)=>{try{const r=await pool.query('SELECT COUNT(*)::int AS count FROM family_shop_products');res.json({ok:true,telegramConfigured:!!BOT_TOKEN,databaseConfigured:!!DATABASE_URL,products:r.rows[0].count});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'index_fixed.html')));

(async()=>{try{await initDb();app.listen(PORT,()=>console.log(`Family Shop running on port ${PORT}`));}catch(e){console.error('Database init error:',e);process.exit(1);}})();
