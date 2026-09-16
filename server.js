// Family Shop API + Telegram order notifications
// Node.js 18+
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Указанный токен и список ID получателей
const BOT_TOKEN = process.env.BOT_TOKEN || '8669028832:AAFD9RISfvSXGk5P0NtKsYaX2klsMUFOtLc';
const ADMIN_IDS = [8094090200, 1657660247];

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(v) {
  return new Intl.NumberFormat('ru-RU').format(Number(v) || 0);
}

function makeOrderMessage(order) {
  const items = Array.isArray(order.items) ? order.items : [];

  const lines = items.map((item, i) =>
    `${i + 1}. ${esc(item.name)} — ${item.qty} шт. × ${formatPrice(item.price)} сум`
  );

  return [
    '🛍 <b>НОВЫЙ ЗАКАЗ</b>',
    '',
    `👤 <b>Имя:</b> ${esc(order.name)}`,
    `📞 <b>Телефон:</b> ${esc(order.phone)}`,
    `📍 <b>Адрес:</b> ${esc(order.address)}`,
    order.telegram_username
      ? `👤 <b>Telegram:</b> @${esc(order.telegram_username)}`
      : '',
    order.telegram_user_id
      ? `🆔 <b>Telegram ID:</b> ${esc(order.telegram_user_id)}`
      : '',
    '',
    '🛒 <b>Что заказали:</b>',
    ...lines,
    '',
    `💰 <b>Итого:</b> ${formatPrice(order.total)} сум + карго`,
    '',
    `🕐 ${new Date().toLocaleString('ru-RU', {
      timeZone: 'Asia/Tashkent'
    })}`
  ]
    .filter(Boolean)
    .join('\n');
}

async function telegramRequest(method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(
      data.description ||
        `Telegram не принял запрос ${method}.`
    );
  }

  return data;
}

async function sendTelegramMessage(chatId, text) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  });
}

async function sendTelegramPhoto(chatId, photo, caption) {
  return telegramRequest('sendPhoto', {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: 'HTML'
  });
}

function makeProductCaption(item, index) {
  return [
    `🛍 <b>${esc(item.name)}</b>`,
    '',
    `📦 <b>Количество:</b> ${Number(item.qty) || 0} шт.`,
    `💰 <b>Цена:</b> ${formatPrice(item.price)} сум`,
    `🔢 <b>Позиция:</b> ${index + 1}`
  ].join('\n');
}

async function notifyAdmin(chatId, order) {
  // 1. Отправляем текстовые данные заказа
  await sendTelegramMessage(
    chatId,
    makeOrderMessage(order)
  );

  // 2. Отправляем фотографии каждого заказанного товара
  const items = Array.isArray(order.items)
    ? order.items
    : [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (!item.img) continue;

    try {
      await sendTelegramPhoto(
        chatId,
        item.img,
        makeProductCaption(item, i)
      );
    } catch (photoError) {
      console.error(
        `Не удалось отправить фото товара ${item.name}:`,
        photoError.message
      );

      await sendTelegramMessage(
        chatId,
        `⚠️ Фото товара «${esc(
          item.name
        )}» не удалось отправить автоматически.`
      );
    }
  }
}

app.post('/api/orders', async (req, res) => {
  try {
    const order = req.body || {};

    if (
      !order.name ||
      !order.phone ||
      !order.address ||
      !Array.isArray(order.items) ||
      !order.items.length
    ) {
      return res.status(400).json({
        error:
          'Заполните имя, телефон, адрес и корзину.'
      });
    }

    const results = await Promise.allSettled(
      ADMIN_IDS.map(id =>
        notifyAdmin(id, order)
      )
    );

    const failed = results.filter(
      r => r.status === 'rejected'
    );

    if (failed.length === results.length) {
      return res.status(502).json({
        error:
          failed[0].reason?.message ||
          'Не удалось отправить заказ в Telegram.'
      });
    }

    res.json({
      ok: true,
      telegramSent:
        results.length - failed.length
    });
  } catch (e) {
    console.error('Order error:', e);

    res.status(500).json({
      error: e.message || 'Ошибка сервера'
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    telegramConfigured: !!BOT_TOKEN
  });
});

app.get('*', (_req, res) =>
  res.sendFile(
    path.join(__dirname, 'index_fixed.html')
  )
);

app.listen(PORT, () =>
  console.log(
    `Family Shop running on port ${PORT}`
  )
);
