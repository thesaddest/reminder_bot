import dotenv from "dotenv";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";
import { POLLING_VERSION, runTelegramPolling, safeErrorMessage } from "./polling";

dotenv.config();

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("BOT_TOKEN is not configured");
}

const bot = new TelegramBot(token, {
  polling: false,
  request: { timeout: 15_000 } as TelegramBot.ConstructorOptions["request"],
});
const pollingController = new AbortController();

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
  const telegramError = error as TelegramApiError | null;
  return safeErrorMessage(telegramError?.response?.body?.description ?? error);
};

const logTelegramError = (operation: string, error: unknown) => {
  // Do not log the entire error object: it can contain a request URL with the bot token.
  console.error(`${new Date().toISOString()} ${operation}: ${getErrorMessage(error)}`);
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
      void sendReminderWithButton(chatId, message);
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

const sendReminderWithButton = async (chatId: number, message: string) => {
  const options = {
    reply_markup: {
      inline_keyboard: [[{ text: "✅ Я выпила!", callback_data: "confirmed" }]],
    },
  };

  const sent = await sendMessage(
    chatId,
    `🔔 ${message}\n\nЕсли кнопка не отвечает: /taken`,
    options
  );
  if (sent) console.log(`${new Date().toISOString()} Reminder delivered to ${chatId}`);
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

// This also needs polling to recover, but has no callback acknowledgement deadline.
bot.onText(/^\/taken(?:@\w+)?(?:\s|$)/i, (msg) => {
  confirmMedication(msg.chat.id);
});

bot.on("callback_query", (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = message?.chat.id;
  console.log(`${new Date().toISOString()} Callback received for ${chatId}`);

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
    void sendReminderWithButton(chatId, message);
    startRepeatReminders(chatId, message);
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
const shutdown = () => {
  console.log("Cleaning up...");
  pollingController.abort();
  pendingReminders.forEach((_, chatId) => {
    clearRepeatReminders(chatId);
  });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

bot.on("error", (error) => {
  logTelegramError("Bot error", error);
});

console.log(`${new Date().toISOString()} Bot is running (${POLLING_VERSION})`);
void runTelegramPolling({
  token,
  signal: pollingController.signal,
  processUpdate: (update) => bot.processUpdate(update),
  log: (message) => console.log(`${new Date().toISOString()} ${message}`),
}).catch((error) => {
  logTelegramError("Polling terminated unexpectedly", error);
  process.exit(1);
});
