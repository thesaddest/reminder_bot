# Reminder bot

Requires Node.js 22 or newer. Set `BOT_TOKEN` in `.env`.

```sh
npm ci
npm test
npm start
```

Daily reminders are sent at 12:00 and 20:00 Europe/Warsaw. Confirm with the
button or `/taken`. Both require incoming polling to be working; `/taken`
can be processed after connectivity recovers without a callback-answer deadline.

## Polling recovery

The bot runs one `getUpdates` request at a time, with a 30-second Telegram
long poll and a 45-second client deadline that aborts a stalled connection.
Failures retry with exponential backoff up to 30 seconds, or longer if
Telegram returns `retry_after`. A successful response, including an empty one,
resets backoff. Recovery preserves subscriptions and active timers in memory.

Timestamped logs show startup version `deadline-polling-v2`, first connection,
recovery, a healthy response approximately every five minutes, and received
callbacks. A reminder is logged as delivered only after `sendMessage` succeeds.

## Updating the PM2 deployment

First inspect the existing process on the server:

```sh
pm2 describe main
```

Check its **script path** and **execution cwd**. The supplied logs showed
`/root/reminder_bot`; use the actual directory reported by PM2. Update that
checkout with the reviewed changes, then run `npm ci` and `npm test` there.
`npm test` also rebuilds `dist`, which matters if PM2 runs `dist/main.js`.

Restart only the existing bot process; do not start a second copy:

```sh
pm2 restart main --update-env
pm2 logs main --lines 30 --timestamp
```

Verify a **new** startup line containing `deadline-polling-v2` followed by
`Polling healthy`. Then send `/start`, subscribe using the button, and verify
a `Callback received` line. Each existing subscriber must subscribe again
after a full process restart: subscriptions and repeat timers are currently
in memory only. Polling reconnects do not require resubscribing.

PM2's output and error logs are separate historical files. Seeing old errors
when opening `pm2 logs` after a restart does not establish when they occurred.
Old `error: [polling_error]` lines are from the library's previous polling loop;
this version logs `Polling failed; retrying in ...` with timestamps.

A 409 error can indicate another process using the same token or an active
webhook; inspect the deployment before changing either. A 401 indicates a
token problem. Never share full request/error objects: URLs contain the token.

The tests simulate stalled headers and response bodies using a local HTTP
server, and exercise rate limits, backoff recovery, update offsets and shutdown.
They never contact Telegram or use the production token.
