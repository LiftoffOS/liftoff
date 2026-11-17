// Slack Web API client with bot-token auth + rate-limit retry.
//
// Mirrors the pattern used in platform-backend's slack-chat-worker but
// designed to be called from the tool-gateway slack-tool-handler in
// tenant-runtime. Stays minimal: POST to api.slack.com/api/<method>,
// observe `ok`, surface errors with `slack_api_error:<code>` so the agent
// gets actionable feedback (e.g. `not_in_channel`, `channel_not_found`).

import { logger } from '../infrastructure/logging';

const BASE_URL = 'https://slack.com/api';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 3;

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string,
    public readonly httpStatus: number,
    public readonly metadata?: Record<string, unknown>,
  ) {
    super(`slack ${method}: ${slackError}`);
  }
}

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: { warnings?: string[]; messages?: string[]; next_cursor?: string };
  [key: string]: unknown;
}

/**
 * POST to a Slack Web API method. Honours 429 `Retry-After`.
 * Throws SlackApiError on `ok=false` so the handler can route per-error.
 */
export async function slackApiCall<T extends SlackApiResponse>(
  method: string,
  botToken: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Rate-limit: respect Retry-After then retry. Slack uses 1 req/sec per
    // channel for chat.postMessage; bursts will trickle through.
    if (res.status === 429 && attempt <= MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after')) || 1;
      logger.warn(
        { method, attempt, retryAfter },
        'Slack API rate-limited; retrying after delay',
      );
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      throw new SlackApiError(method, `http_${res.status}`, res.status);
    }
    const parsed = (await res.json()) as T;
    if (!parsed.ok) {
      throw new SlackApiError(method, parsed.error ?? 'unknown_error', res.status, {
        response_metadata: parsed.response_metadata,
        warning: parsed.warning,
      });
    }
    return parsed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
