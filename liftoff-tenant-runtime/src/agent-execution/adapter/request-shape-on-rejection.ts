// What a request LOOKED like, logged when the provider refuses it.
//
// A provider's 4xx names the failure and rarely the parameter: Z.AI answers
// every malformed request with code 1210, "Invalid API parameter, please check
// the documentation", and the documentation lists no parameters. Diagnosing one
// then means guessing at the request and trying again — which is how a run on
// GLM stayed undiagnosed across three deploys while the same model answered a
// chat turn fine, and the only known difference was "triggered by an event".
//
// So on a rejection the request's SHAPE is logged: the top-level parameter
// names, the tool names, the message roles and content kinds, the model. Never
// the content. A shape is enough to see the parameter a provider does not
// accept, and it is the one thing the provider's error will not say.
//
// Bounded and best-effort: this runs inside a fetch wrapper on the hot path,
// and a logging failure here must never turn into a failed request.

import { logger } from '../../infrastructure/logging';

const MAX_TOOL_NAMES = 200;

interface ShapeOf {
  paramKeys: string[];
  model?: string;
  toolCount?: number;
  toolNames?: string[];
  toolChoice?: unknown;
  messageRoles?: string[];
  messageContentKinds?: string[];
  emptyContentMessages?: number;
  systemMessages?: number;
  /** One line per message, in order: role, content kind, how many tool calls
   *  it makes, whether it answers one. The roles alone said a rejected request
   *  carried three assistant turns and two tool results before its first
   *  model call, and could not say what they were. */
  messageOutline?: string[];
}

const MAX_OUTLINE = 24;

/** The shape of one chat-completions body, content elided. */
export function requestShapeOf(body: unknown): ShapeOf | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const out: ShapeOf = { paramKeys: Object.keys(b).sort() };
  if (typeof b.model === 'string') out.model = b.model;
  if (Array.isArray(b.tools)) {
    out.toolCount = b.tools.length;
    out.toolNames = b.tools
      .slice(0, MAX_TOOL_NAMES)
      .map((t) => {
        const fn = (t as { function?: { name?: unknown }; name?: unknown }) ?? {};
        return String(fn.function?.name ?? fn.name ?? '?');
      });
  }
  if (b.tool_choice !== undefined) out.toolChoice = b.tool_choice;
  if (Array.isArray(b.messages)) {
    out.messageRoles = b.messages.map((m) => String((m as { role?: unknown })?.role ?? '?'));
    // What KIND each content is — a string, an array of typed parts, or
    // nothing. An empty or absent content is its own well-known rejection.
    const kinds = new Set<string>();
    const outline: string[] = [];
    let empty = 0;
    let system = 0;
    for (const m of b.messages as Array<Record<string, unknown>>) {
      if (m?.role === 'system') system += 1;
      const c = m?.content;
      let kind: string;
      if (c === undefined || c === null || c === '') { empty += 1; kind = 'empty'; }
      else if (typeof c === 'string') kind = `string(${c.length})`;
      else if (Array.isArray(c)) {
        kind = c.length === 0 ? 'empty' : c.map((part) => `part:${String((part as { type?: unknown })?.type ?? '?')}`).join('+');
        if (c.length === 0) empty += 1;
      } else kind = typeof c;
      kinds.add(kind.replace(/\(\d+\)/, ''));
      const calls = Array.isArray(m?.tool_calls) ? (m.tool_calls as unknown[]).length : 0;
      const answers = typeof m?.tool_call_id === 'string';
      if (outline.length < MAX_OUTLINE) {
        outline.push(`${String(m?.role)}:${kind}${calls ? `:calls=${calls}` : ''}${answers ? ':answers' : ''}`);
      }
    }
    out.messageContentKinds = [...kinds].sort();
    out.emptyContentMessages = empty;
    out.systemMessages = system;
    out.messageOutline = outline;
  }
  return out;
}

/**
 * A fetch that logs the request's shape whenever the provider answers 4xx.
 *
 * Wraps rather than replaces: the inner fetch is whatever the caller would have
 * used, so auth, retries and everything else stay exactly as they were.
 */
export function fetchLoggingShapeOnRejection(
  inner: typeof fetch,
  target: string,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const res = await inner(url, init);
    if (res.status >= 400 && res.status < 500) {
      try {
        const raw = init?.body;
        const text = typeof raw === 'string' ? raw : undefined;
        const shape = text ? requestShapeOf(JSON.parse(text)) : null;
        logger.warn({
          event: 'provider_rejected_request',
          target,
          status: res.status,
          url: typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url,
          ...(shape ?? { paramKeys: [] }),
        }, 'provider rejected the request; this is what it looked like');
      } catch {
        // A logging failure is not a request failure.
      }
    }
    return res;
  }) as typeof fetch;
}
