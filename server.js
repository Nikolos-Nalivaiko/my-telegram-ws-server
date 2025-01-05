// server.js
const express = require("express");
const bodyParser = require("body-parser");
const { WebSocketServer } = require("ws");
const axios = require("axios");

// Берём из переменных окружения (Railway позволит их задавать),
// или указываем какие-то дефолты
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  "6389303268:AAEoYFk9XHYq6dMnugS7UIaSuweODcTQEm8";
const PORT = process.env.PORT || 3000;

// Храним клиентов: clientId -> WebSocket
const clients = new Map();

////////////////////////////////////////////////////
// 1) Запуск WebSocket-сервера (на том же порту, что Express)
////////////////////////////////////////////////////
let server; // Сохраним экземпляр HTTP-сервера
const startWebSocket = (serverInstance) => {
  // Инициализируем WSS, передав наш http-сервер
  const wss = new WebSocketServer({ server: serverInstance });

  wss.on("connection", (ws, req) => {
    // Получим client_id из query ?client_id=xxxx
    const params = new URLSearchParams(req.url.split("?")[1]);
    const clientId = params.get("client_id") || "unknown_client";

    console.log("[WebSocket] Новый клиент:", clientId);
    clients.set(clientId, ws);

    ws.on("close", () => {
      console.log("[WebSocket] Клиент отключился:", clientId);
      clients.delete(clientId);
    });

    ws.on("message", (msg) => {
      console.log(`[WebSocket] Сообщение от ${clientId}: ${msg}`);
      // Если нужно, можно что-то сделать с сообщением
    });
  });
};

////////////////////////////////////////////////////
// 2) Express-приложение для принятия вебхука от Telegram
////////////////////////////////////////////////////
const app = express();
app.use(bodyParser.json());

// Пример эндпоинта, куда Телеграм будет слать обновления
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    // Если пришёл callback_query (нажатие на inline-кнопку)
    if (update.callback_query) {
      const cbData = update.callback_query.data; // Это наш client_id
      const fromUser =
        update.callback_query.from.username || update.callback_query.from.id;
      console.log(
        `[Telegram] Inline-кнопка нажата. clientId=${cbData}, from=${fromUser}`
      );

      // Можно написать оператору или отправить подсказку.
      // Но главное – мы знаем client_id
      // Для примера сразу отправим в Telegram ответ:
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: update.callback_query.message.chat.id,
          text: `Введите ответ в формате: ${cbData}: ваш текст`,
        }
      );

      return res.sendStatus(200);
    }

    // Если обычное сообщение
    if (update.message) {
      const text = update.message.text || "";
      const chatId = update.message.chat.id;

      // Допустим, оператор отправляет ответ вида: "client_abc123: Привет!"
      if (text.includes(":")) {
        const [rawClientId, operatorReply] = text.split(":");
        const trimmedClientId = rawClientId.trim();
        const trimmedReply = operatorReply.trim();

        // Найдём WebSocket‑подключение этого клиента
        if (clients.has(trimmedClientId)) {
          const wsClient = clients.get(trimmedClientId);
          wsClient.send(`Оператор: ${trimmedReply}`);

          // Заодно отправим оператору подтверждение
          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `Ответ отправлен пользователю ${trimmedClientId} ✔️`,
            }
          );
        } else {
          // Клиент не найден
          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `Клиент ${trimmedClientId} не найден или отключился. ❌`,
            }
          );
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[Webhook] Ошибка:", err);
    res.sendStatus(500);
  }
});

// Запускаем http-сервер
server = app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
  // Стартуем WebSocket-сервер поверх этого же http-сервера
  startWebSocket(server);
});
