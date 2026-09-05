import type TelegramBot from "node-telegram-bot-api";
import { setTimeout as delay } from "node:timers/promises";

export const POLLING_VERSION = "deadline-polling-v2";

type PollingOptions = {
  token: string;
  signal: AbortSignal;
  processUpdate: (update: TelegramBot.Update) => void;
  log: (message: string) => void;
  // Injectable for offline failure/recovery tests.
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  intervalMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
};

class PollingError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) {
    super(message);
  }
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[REDACTED_BOT_TOKEN]");
}

async function getUpdates(options: PollingOptions, offset: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();

  const timeoutMs = options.requestTimeoutMs ?? 45_000;
  // Telegram's `timeout: 30` only controls server-side long polling. This timer
  // aborts the actual HTTP request, including a stalled response body.
  const deadline = setTimeout(() => {
    controller.abort(new Error(`getUpdates exceeded its ${timeoutMs}ms deadline`));
  }, timeoutMs);

  try {
    const response = await (options.fetch ?? fetch)(
      `https://api.telegram.org/bot${options.token}/getUpdates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        }),
        signal: controller.signal,
      }
    );

    const body = await response.json().catch(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new PollingError(`getUpdates returned HTTP ${response.status} with invalid JSON`);
    }) as {
      ok?: boolean;
      result?: TelegramBot.Update[];
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    } | null;

    if (!response.ok || !body?.ok) {
      const code = body?.error_code ?? response.status;
      const retryAfter = body?.parameters?.retry_after;
      const retryAfterMs = typeof retryAfter === "number" && Number.isFinite(retryAfter)
        ? Math.max(0, retryAfter * 1000) : 0;
      const hint = code === 409
        ? "; check for another bot process or a configured webhook"
        : code === 401 ? "; check the deployed BOT_TOKEN" : "";
      throw new PollingError(
        `getUpdates ${code}: ${body?.description ?? response.statusText}${hint}`,
        retryAfterMs
      );
    }

    if (!Array.isArray(body.result) || body.result.some(update => !Number.isSafeInteger(update?.update_id))) {
      throw new PollingError("getUpdates returned an invalid update list");
    }
    return body.result;
  } finally {
    clearTimeout(deadline);
    options.signal.removeEventListener("abort", abort);
  }
}

// One awaited request at a time. Reconnect without restarting the process so
// subscribers and active reminder timers survive a network outage.
export async function runTelegramPolling(options: PollingOptions): Promise<void> {
  let offset = 0;
  let failures = 0;
  let lastHealthLog = 0;
  options.log(`Starting ${POLLING_VERSION}: long poll 30s, request deadline ${options.requestTimeoutMs ?? 45_000}ms`);

  while (!options.signal.aborted) {
    let waitMs = options.intervalMs ?? 300;
    try {
      const updates = await getUpdates(options, offset);
      if (options.signal.aborted) break;

      // Empty replies are healthy too; no button taps are needed to prove recovery.
      if (failures > 0 || lastHealthLog === 0 || Date.now() - lastHealthLog >= 300_000) {
        options.log(`Polling ${failures > 0 ? "recovered" : "healthy"}; received ${updates.length} updates`);
        lastHealthLog = Date.now();
      }
      failures = 0;

      for (const update of updates) {
        if (options.signal.aborted) break;
        try {
          options.processUpdate(update);
        } catch (error) {
          // Isolate a bad handler so one update cannot stop reception forever.
          options.log(`Update ${update.update_id} handler failed: ${safeErrorMessage(error)}`);
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (options.signal.aborted) break;
      failures += 1;
      const backoff = Math.min(
        options.maxBackoffMs ?? 30_000,
        (options.backoffMs ?? 1000) * 2 ** Math.min(failures - 1, 16)
      );
      waitMs = Math.max(backoff, error instanceof PollingError ? error.retryAfterMs : 0);
      options.log(`Polling failed; retrying in ${waitMs}ms: ${safeErrorMessage(error)}`);
    }

    try {
      await delay(waitMs, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
  options.log("Polling stopped");
}
