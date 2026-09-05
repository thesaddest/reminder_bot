const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const TelegramBot = require('node-telegram-bot-api');
const polling = require('../dist/polling');

test('a recovered callback cancels repeats despite expired acknowledgement; /taken also cancels repeats', async () => {
  const pending = new Set();
  const schedules = [];
  const errors = [];
  let receiver;
  let bot;

  class OfflineBot extends TelegramBot {
    constructor(token, options) {
      assert.equal(options.polling, false, 'only the bounded polling loop may receive updates');
      assert.equal(options.request.timeout, 15000);
      super(token, options);
      bot = this;
    }
    sendMessage() { return Promise.resolve({ message_id: 1 }); }
    answerCallbackQuery() { return Promise.reject(new Error('query is too old')); }
    editMessageReplyMarkup() { return Promise.reject(new Error('Telegram unavailable')); }
  }

  // Run the actual compiled entry point with offline Telegram and scheduler
  // adapters. No .env access, live token, real timers or network calls.
  vm.runInNewContext(readFileSync(require.resolve('../dist/main'), 'utf8'), {
    exports: {},
    require: name => {
      if (name === 'dotenv') return { config() {} };
      if (name === 'node-cron') return { schedule: (_, callback) => schedules.push(callback) };
      if (name === 'node-telegram-bot-api') return OfflineBot;
      if (name === './polling') return {
        ...polling,
        runTelegramPolling: async options => { receiver = options.processUpdate; },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: { BOT_TOKEN: 'offline-test-token' }, on() {}, exit() { throw new Error('Unexpected exit'); } },
    console: { log() {}, error: message => errors.push(message) },
    AbortController,
    setTimeout: callback => { pending.add(callback); return callback; },
    clearTimeout: timer => pending.delete(timer),
  });

  const message = { message_id: 1, date: 1, chat: { id: 1234, type: 'private' } };
  receiver({ update_id: 1, callback_query: { id: 'subscribe', data: 'set_reminder', message } });
  schedules[0]();
  assert.equal(pending.size, 36);
  receiver({ update_id: 2, callback_query: { id: 'expired', data: 'confirmed', message } });
  assert.equal(pending.size, 0, 'confirmation cancels local repeats immediately');

  schedules[1]();
  assert.equal(pending.size, 36, 'subscription survives incoming update handling');
  receiver({ update_id: 3, message: { ...message, text: '/taken' } });
  assert.equal(pending.size, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(errors.some(message => message.includes('query is too old')));
  assert.ok(errors.some(message => message.includes('Telegram unavailable')));
  assert.equal(bot.isPolling(), false);
});
