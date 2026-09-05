const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { runTelegramPolling, safeErrorMessage } = require('../dist/polling');

const reply = (result = []) => Response.json({ ok: true, result });

function setup(t, extra = {}) {
  const controller = new AbortController();
  const logs = [];
  const updates = [];
  const safety = setTimeout(() => controller.abort(), 5000);
  t.after(() => { clearTimeout(safety); controller.abort(); });
  return {
    controller, logs, updates,
    options: {
      token: '123456:fake_token_for_offline_testing_only',
      signal: controller.signal,
      log: message => logs.push(message),
      processUpdate: update => updates.push(update),
      intervalMs: 1, backoffMs: 10, maxBackoffMs: 40,
      ...extra,
    },
  };
}

for (const stage of ['headers', 'body']) {
  test(`aborts a real HTTP request stalled at ${stage}, reconnects and delivers a callback`, async t => {
    const ctx = setup(t, { requestTimeoutMs: 250 });
    let calls = 0;
    let firstClosed = false;
    const server = http.createServer((req, res) => {
      calls++;
      if (calls === 1) {
        res.on('close', () => { firstClosed = true; });
        if (stage === 'body') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{"ok":true,"result":');
        }
        return; // Deliberately never finish the request.
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: [{ update_id: 42, callback_query: { id: 'tap', data: 'confirmed' } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    await runTelegramPolling({
      ...ctx.options,
      fetch: (_, options) => fetch(endpoint, options),
      processUpdate: update => { ctx.updates.push(update); ctx.controller.abort(); },
    });
    assert.equal(calls, 2);
    assert.equal(firstClosed, true, 'aborts the underlying connection rather than abandoning a promise');
    assert.equal(ctx.updates[0].callback_query.data, 'confirmed');
    assert.ok(ctx.logs.some(line => line.includes('deadline')));
    assert.ok(ctx.logs.some(line => line.includes('Polling recovered')));
  });
}

test('honors retry_after, including when it exceeds the backoff cap', async t => {
  const ctx = setup(t);
  const times = [];
  await runTelegramPolling({
    ...ctx.options,
    fetch: async () => {
      times.push(performance.now());
      if (times.length === 1) {
        return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0.15 } }, { status: 429 });
      }
      return reply([{ update_id: 1 }]);
    },
    processUpdate: () => ctx.controller.abort(),
  });
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 145);
  assert.ok(ctx.logs.some(line => line.includes('retrying in 150ms')));
});

test('backs off on 502, HTML 504 and reset, then resets after an empty success', async t => {
  const ctx = setup(t);
  let calls = 0;
  await runTelegramPolling({
    ...ctx.options,
    fetch: async () => {
      switch (++calls) {
        case 1: return Response.json({ ok: false, error_code: 502 }, { status: 502 });
        case 2: return new Response('<html>Gateway Timeout</html>', { status: 504 });
        case 3: throw new Error('ECONNRESET');
        case 4: return reply();
        case 5: throw new Error('ECONNRESET');
        default: return reply([{ update_id: 2 }]);
      }
    },
    processUpdate: () => ctx.controller.abort(),
  });
  const waits = ctx.logs.filter(line => line.includes('retrying')).map(line => Number(line.match(/in (\d+)ms/)[1]));
  assert.deepEqual(waits, [10, 20, 40, 10]);
  assert.ok(ctx.logs.includes('Polling recovered; received 0 updates'));
});

test('retains the update offset across reconnects and isolates a failing handler', async t => {
  const ctx = setup(t);
  const offsets = [];
  await runTelegramPolling({
    ...ctx.options,
    fetch: async (_, options) => {
      offsets.push(JSON.parse(options.body).offset);
      if (offsets.length === 1) return reply([{ update_id: 10 }, { update_id: 11 }]);
      if (offsets.length === 2) throw new Error('connection reset');
      return reply([{ update_id: 12 }]);
    },
    processUpdate: update => {
      ctx.updates.push(update.update_id);
      if (update.update_id === 10) throw new Error('handler failed');
      if (update.update_id === 12) ctx.controller.abort();
    },
  });
  assert.deepEqual(offsets, [0, 12, 12]);
  assert.deepEqual(ctx.updates, [10, 11, 12]);
});

test('shutdown aborts an active request without starting another', async t => {
  const ctx = setup(t);
  let calls = 0;
  await runTelegramPolling({
    ...ctx.options,
    fetch: (_, { signal }) => new Promise((resolve, reject) => {
      calls++;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      ctx.controller.abort();
    }),
  });
  assert.equal(calls, 1);
  assert.ok(!ctx.logs.some(line => line.includes('Polling failed')));
});

test('shutdown interrupts a rate-limit wait', async t => {
  const ctx = setup(t);
  let calls = 0;
  await runTelegramPolling({
    ...ctx.options,
    fetch: async () => {
      calls++;
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3600 } }, { status: 429 });
    },
    log: message => { if (message.includes('retrying')) ctx.controller.abort(); },
  });
  assert.equal(calls, 1);
});

test('error messages redact bot tokens even inside a URL', () => {
  assert.equal(
    safeErrorMessage(new Error('failed https://api.telegram.org/bot123456:fake_token_for_offline_testing_only/getUpdates')),
    'failed https://api.telegram.org/bot[REDACTED_BOT_TOKEN]/getUpdates'
  );
  assert.equal(safeErrorMessage(null), 'null');
});
