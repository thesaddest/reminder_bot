import dotenv from "dotenv";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const token = process.env.BOT_TOKEN!;
const bot = new TelegramBot(token, { polling: true });

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

  bot.sendMessage(chatId, `🔔 ${message}`, options);
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

  bot.sendMessage(
    chatId,
    "Привет, солнце, кликни кнопку ниже, чтобы получить уведомление",
    options
  );
});

bot.on("callback_query", (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = message?.chat.id;

  if (data === "set_reminder" && chatId) {
    console.log("Setting reminder for", chatId);
    subscribers.add(chatId);

    bot.sendMessage(
      chatId,
      `✅ Напоминашка поставлена ⏰ Повторяется каждый день в 12:00 и в 20:00`
    );
  } else if (data === "confirmed" && chatId) {
    // User confirmed they took the medication
    clearRepeatReminders(chatId);

    bot.sendMessage(chatId, `🎉 Отлично, солнышко! До следующего напоминания 💊`);
  }

  // Answer the callback query to remove loading state
  bot.answerCallbackQuery(callbackQuery.id);
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

bot.on("error", (error) => {
  console.log("Bot error:", error);
});

console.log("Bot is running...");
