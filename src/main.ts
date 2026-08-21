import dotenv from "dotenv";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("BOT_TOKEN is not configured");
}

const BASE_POLLING_INTERVAL_MS = 300;
const MAX_POLLING_BACKOFF_MS = 30_000;
const pollingOptions = {
  interval: BASE_POLLING_INTERVAL_MS,
  params: { timeout: 30 },
};
const bot = new TelegramBot(token, { polling: pollingOptions });

type TelegramApiError = Error & {
  code?: string;
  response?: {
    statusCode?: number;
    body?: {
      description?: string;
      parameters?: { retry_after?: number };
    };
  };
};

const getErrorMessage = (error: unknown) => {
  const telegramError = error as TelegramApiError;
  return telegramError.response?.body?.description ?? telegramError.message ?? String(error);
};

const logTelegramError = (operation: string, error: unknown) => {
  // Do not log the entire error object: it can contain a request URL with the bot token.
  console.error(`${operation}: ${getErrorMessage(error)}`);
};

const sendMessage = async (
  chatId: number,
  text: string,
  options?: TelegramBot.SendMessageOptions
) => {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    logTelegramError(`Could not send a message to ${chatId}`, error);
    return undefined;
  }
};

const subscribers: Set<number> = new Set();
const pendingReminders: Map<number, NodeJS.Timeout[]> = new Map();

const NOON_MESSAGE = "Солнце, пора пить колёсики (дневные 💊)";
const EVENING_MESSAGE = "Солнце, пора пить колёсики (вечерние 🌙)";

const startRepeatReminders = (chatId: number, message: string) => {
  // Clear any existing repeat reminders for this user
  clearRepeatReminders(chatId);

  const intervals: NodeJS.Timeout[] = [];

  // Set up repeat every 5 minutes (36 times max = 3 hours total)
  for (let i = 1; i <= 36; i++) {
    const timeout = setTimeout(() => {
      sendReminderWithButton(chatId, message);
      console.log(`Repeat reminder ${i} sent to ${chatId}`);
    }, i * 5 * 60 * 1000); // 5 minutes intervals

    intervals.push(timeout);
  }

  // Store intervals for this user
  pendingReminders.set(chatId, intervals);
};

const clearRepeatReminders = (chatId: number) => {
  const intervals = pendingReminders.get(chatId);
  if (intervals) {
    intervals.forEach((interval) => clearTimeout(interval));
    pendingReminders.delete(chatId);
    console.log(`Cleared repeat reminders for ${chatId}`);
  }
};

const sendReminderWithButton = (chatId: number, message: string) => {
  const options = {
    reply_markup: {
      inline_keyboard: [[{ text: "✅ Я выпила!", callback_data: "confirmed" }]],
    },
  };

  void sendMessage(
    chatId,
    `🔔 ${message}\n\nЕсли кнопка не отвечает: /taken`,
    options
  );
};

const confirmMedication = (chatId: number, messageId?: number) => {
  clearRepeatReminders(chatId);

  if (messageId !== undefined) {
    void bot
      .editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: messageId }
      )
      .catch((error) => logTelegramError("Could not disable reminder button", error));
  }

  void sendMessage(chatId, `🎉 Отлично, солнышко! До следующего напоминания 💊`);
};

// Handle /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔔 Поставить напоминание", callback_data: "set_reminder" }],
      ],
    },
  };

  void sendMessage(
    chatId,
    "Привет, солнце, кликни кнопку ниже, чтобы получить уведомление",
    options
  );
});

// A regular message remains usable after a polling outage, unlike an expired callback query.
bot.onText(/^\/taken(?:@\w+)?(?:\s|$)/i, (msg) => {
  confirmMedication(msg.chat.id);
});

bot.on("callback_query", (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = message?.chat.id;

  // Start acknowledging immediately. The action below must still run if this request fails
  // because Telegram can expire callback query IDs during an outage.
  void bot
    .answerCallbackQuery(callbackQuery.id)
    .catch((error) => logTelegramError("Could not answer callback query", error));

  if (data === "set_reminder" && chatId) {
    console.log("Setting reminder for", chatId);
    subscribers.add(chatId);

    void sendMessage(
      chatId,
      `✅ Напоминашка поставлена ⏰ Повторяется каждый день в 12:00 и в 20:00`
    );
  } else if (data === "confirmed" && chatId) {
    confirmMedication(chatId, message.message_id);
  }
});

const sendDailyReminders = (message: string) => {
  console.log(`Sending daily reminders: "${message}"`);

  subscribers.forEach((chatId) => {
    sendReminderWithButton(chatId, message);
    startRepeatReminders(chatId, message);
    console.log(`Initial reminder sent to ${chatId}`);
  });
};

// Daily reminder at 12:00 PM (noon)
cron.schedule("0 12 * * *", () => sendDailyReminders(NOON_MESSAGE), {
  timezone: "Europe/Warsaw",
});

// Daily reminder at 8:00 PM
cron.schedule("0 20 * * *", () => sendDailyReminders(EVENING_MESSAGE), {
  timezone: "Europe/Warsaw",
});

// Cleanup on bot shutdown
process.on("SIGINT", () => {
  console.log("Cleaning up...");
  pendingReminders.forEach((_, chatId) => {
    clearRepeatReminders(chatId);
  });
  process.exit(0);
});

let consecutivePollingErrors = 0;
let resetPollingBackoff: NodeJS.Timeout | undefined;

const markPollingHealthy = () => {
  consecutivePollingErrors = 0;
  pollingOptions.interval = BASE_POLLING_INTERVAL_MS;
  if (resetPollingBackoff) {
    clearTimeout(resetPollingBackoff);
    resetPollingBackoff = undefined;
  }
};

bot.on("message", markPollingHealthy);
bot.on("callback_query", markPollingHealthy);

bot.on("polling_error", (error) => {
  consecutivePollingErrors += 1;

  const telegramError = error as TelegramApiError;
  const retryAfterMs =
    (telegramError.response?.body?.parameters?.retry_after ?? 0) * 1000;
  const exponentialBackoffMs = Math.min(
    MAX_POLLING_BACKOFF_MS,
    1000 * 2 ** (consecutivePollingErrors - 1)
  );

  // node-telegram-bot-api reads this value before scheduling its next poll.
  pollingOptions.interval = Math.max(retryAfterMs, exponentialBackoffMs);

  if (resetPollingBackoff) clearTimeout(resetPollingBackoff);
  resetPollingBackoff = setTimeout(() => {
    consecutivePollingErrors = 0;
    pollingOptions.interval = BASE_POLLING_INTERVAL_MS;
    resetPollingBackoff = undefined;
  }, Math.max(60_000, pollingOptions.interval * 2));

  console.error(
    `Polling failed; retrying in ${Math.ceil(pollingOptions.interval / 1000)}s: ${getErrorMessage(error)}`
  );
});

bot.on("error", (error) => {
  logTelegramError("Bot error", error);
});

console.log("Bot is running...");
