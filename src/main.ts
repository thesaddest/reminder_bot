import dotenv from "dotenv";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const token = process.env.BOT_TOKEN!;
const bot = new TelegramBot(token, { polling: true });

const reminders: Map<number, string> = new Map();
const pendingReminders: Map<number, NodeJS.Timeout[]> = new Map();

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
    const reminderText = "Солнце, пора пить колёсики";
    console.log("Setting reminder for", chatId);
    // Store the reminder
    reminders.set(chatId, reminderText);

    bot.sendMessage(
      chatId,
      `✅ Напоминашка поставлена ⏰ Повторяется каждый день в 20:00`
    );
  } else if (data === "confirmed" && chatId) {
    // User confirmed they took the medication
    clearRepeatReminders(chatId);

    bot.sendMessage(chatId, `🎉 Отлично, солнышко! Увидимся завтра в 20:00 💊`);
  }

  // Answer the callback query to remove loading state
  bot.answerCallbackQuery(callbackQuery.id);
});

// Daily reminder at 8:00 PM
cron.schedule(
  "0 20 * * *",
  () => {
    console.log("Sending daily reminders...");

    reminders.forEach((message, chatId) => {
      // Send initial reminder with confirmation button
      sendReminderWithButton(chatId, message);

      // Start repeat reminders every 5 minutes
      startRepeatReminders(chatId, message);

      console.log(`Initial reminder sent to ${chatId}`);
    });
  },
  {
    timezone: "Europe/Warsaw",
  }
);

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
