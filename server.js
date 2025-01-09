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

// Храним контекст ответа: operatorId -> clientId
const replyContext = new Map();

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

// Эндпоинт, куда Телеграм будет слать обновления
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    // Обработка callback_query (нажатие на inline-кнопку "Відповісти")
    if (update.callback_query) {
      const clientId = update.callback_query.data; // Это наш client_id
      const operatorId = update.callback_query.from.id;
      const chatId = update.callback_query.message.chat.id;

      console.log(
        `[Telegram] Inline-кнопка нажата. clientId=${clientId}, operatorId=${operatorId}`
      );

      // Сохраняем контекст ответа: оператор -> клиент
      replyContext.set(operatorId, clientId);

      // Отправляем оператору запрос на ввод сообщения
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: `Введіть ваше повідомлення для клієнта ${clientId}:`,
        }
      );

      return res.sendStatus(200);
    }

    // Обработка обычных сообщений
    if (update.message) {
      const text = update.message.text || "";
      const chatId = update.message.chat.id;
      const operatorId = update.message.from.id;

      // Проверяем, существует ли контекст ответа для этого оператора
      if (replyContext.has(operatorId)) {
        const clientId = replyContext.get(operatorId);
        const operatorReply = text.trim();

        if (clients.has(clientId)) {
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
          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `Користувач ${clientId} не знайдений або відключився. ❌`,
            }
          );
        }

        // Очищаем контекст ответа после обработки
        replyContext.delete(operatorId);
      } 
      // Альтернативная обработка сообщений в формате "clientId: текст"
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
          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `Користувач ${trimmedClientId} не знайдений або відключився. ❌`,
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

// Запуск HTTP-сервера
server = app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
  // Запуск WebSocket-сервера поверх этого же HTTP-сервера
  startWebSocket(server);
});

