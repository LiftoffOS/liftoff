/**
 * Claude Agent SDK built-in web tools, enabled by name via `query()`'s
 * `allowedTools`. Default-on for every agent — native (fast/ephemeral),
 * complementing the platform web_fetch_advanced / web_research tools
 * (heavy/persistent-to-memory). These are SDK built-in tool names, NOT raw
 * Messages-API `web_search_*` server-tool blocks.
 *
 * Single source of truth for both query() call sites:
 *   - interactive chat  (interactive-chat/chat-turn-handler.ts)
 *   - autonomous adapter (agent-execution/adapter/anthropic/index.ts)
 *
 * Omitting the SDK `tools` option keeps these in the base set (sdk.d.ts:1024-1033
 * — `tools` is the *restriction* knob); listing them in `allowedTools`
 * auto-approves them past the permission gate / canUseTool.
 */
export const ANTHROPIC_NATIVE_WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;
