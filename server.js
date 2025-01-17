/////////////////////////////////////////////
// server.js
/////////////////////////////////////////////
const express = require("express");
const bodyParser = require("body-parser");
const { WebSocketServer } = require("ws");
const axios = require("axios");

// Дані з оточення (Railway, Heroku), або ваші дефолтні:
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  "6389303268:AAEoYFk9XHYq6dMnugS7UIaSuweODcTQEm8";

const PORT = process.env.PORT || 3000;

// Хранимо відкриті з’єднання: clientId -> WebSocket
const clients = new Map();

// Хранимо контекст відповіді: operatorId -> clientId (кому оператор зараз відповідає)
const replyContext = new Map();

// Хранимо офлайн-повідомлення: clientId -> array of messages
// Якщо користувач офлайн, сюди додаємо його повідомлення, щоб відправити коли підключиться.
const offlineMessages = new Map();

////////////////////////////////////////////////////
// 1) Запуск WebSocket-сервера (на тому ж порту, що і Express)
////////////////////////////////////////////////////
let server;
const startWebSocket = (serverInstance) => {
  const wss = new WebSocketServer({ server: serverInstance });

  wss.on("connection", (ws, req) => {
    // Витягаємо client_id із query ?client_id=xxxx
    const params = new URLSearchParams(req.url.split("?")[1]);
    const clientId = params.get("client_id") || "unknown_client";

    console.log("[WebSocket] Новий клієнт:", clientId);
    // Зберігаємо підключення
    clients.set(clientId, ws);

    // Якщо в offlineMessages є якісь непрочитані (нерозіслані) повідомлення 
    // для цього clientId, одразу відправимо:
    if (offlineMessages.has(clientId)) {
      const messages = offlineMessages.get(clientId);
      messages.forEach((msg) => {
        ws.send(msg);
      });
      // Після успішного відправлення очищаємо
      offlineMessages.delete(clientId);
    }

    ws.on("close", () => {
      console.log("[WebSocket] Клієнт відключився:", clientId);
      // Видаляємо з мапи відкритих підключень
      clients.delete(clientId);
    });

    ws.on("message", (msg) => {
      console.log(`[WebSocket] Повідомлення від ${clientId}: ${msg}`);
      // Якщо потрібно, можна тут обробити повідомлення від самого користувача
    });
  });
};

////////////////////////////////////////////////////
// 2) Express-додаток для прийому вебхука від Telegram
////////////////////////////////////////////////////
const app = express();
app.use(bodyParser.json());

// Точка входу, куди Telegram слатиме оновлення
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    // Якщо натиснута inline-кнопка "Відповісти"
    if (update.callback_query) {
      const clientId = update.callback_query.data; // це наш client_id
      const operatorId = update.callback_query.from.id;
      const chatId = update.callback_query.message.chat.id;

      console.log(
        `[Telegram] Inline-кнопка натиснута. clientId=${clientId}, operatorId=${operatorId}`
      );

      // Зберігаємо контекст: оператор -> clientId
      replyContext.set(operatorId, clientId);

      // Просимо оператора ввести повідомлення
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: `Введіть ваше повідомлення для клієнта ${clientId}:`,
      });

      return res.sendStatus(200);
    }

    // Якщо звичайне повідомлення
    if (update.message) {
      const text = update.message.text || "";
      const chatId = update.message.chat.id;
      const operatorId = update.message.from.id;

      // Якщо оператор уже натискав "Відповісти", і ми знаємо clientId
      if (replyContext.has(operatorId)) {
        const clientId = replyContext.get(operatorId);
        const operatorReply = text.trim();

        // Перевіряємо, чи онлайн зараз клієнт
        if (clients.has(clientId)) {
          // Відправляємо напряму
          const wsClient = clients.get(clientId);
          wsClient.send(`Оператор: ${operatorReply}`);

          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `Відповідь відправлена користувачу ${clientId} ✔️`,
            }
          );
        } else {
          // Якщо клієнт офлайн, зберігаємо офлайн-повідомлення
          let stored = offlineMessages.get(clientId) || [];
          stored.push(`Оператор: ${operatorReply}`);
          offlineMessages.set(clientId, stored);

          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `Користувач ${clientId} зараз офлайн. Повідомлення буде доставлено, коли він знову з'явиться онлайн.`,
            }
          );
        }

        // Видаляємо контекст
        replyContext.delete(operatorId);
      } 
      // Або альтернативна форма "clientId: текст"
      else if (text.includes(":")) {
        const [rawClientId, operatorReply] = text.split(":");
        const trimmedClientId = rawClientId.trim();
        const trimmedReply = operatorReply.trim();

        if (clients.has(trimmedClientId)) {
          const wsClient = clients.get(trimmedClientId);
          wsClient.send(`Оператор: ${trimmedReply}`);

          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `Відповідь відправлена користувачу ${trimmedClientId} ✔️`,
            }
          );
        } else {
          // Зберігаємо офлайн
          let stored = offlineMessages.get(trimmedClientId) || [];
          stored.push(`Оператор: ${trimmedReply}`);
          offlineMessages.set(trimmedClientId, stored);

          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `Користувач ${trimmedClientId} наразі офлайн. Повідомлення збережено і буде доставлено пізніше.`,
            }
          );
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[Webhook] Помилка:", err);
    res.sendStatus(500);
  }
});

// Запуск HTTP-сервера
server = app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
  // Запускаємо WebSocket-сервер поверх цього ж HTTP-сервера
  startWebSocket(server);
});

