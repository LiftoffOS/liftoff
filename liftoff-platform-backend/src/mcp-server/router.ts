// MCP Server Router — Streamable HTTP transport
// Handles MCP protocol: initialize handshake, tools/list, tools/call.
// Auth via mcpAuthMiddleware (liftoff_mcp_* static tokens and liftoff_oat_* OAuth
// access tokens — prefix routing lives in mcp-auth.ts).
//
// Protocol conformance (plan v6.1 Phase 0):
//   - Version negotiation over SUPPORTED_PROTOCOL_VERSIONS; a missing
//     MCP-Protocol-Version header on post-initialize requests is treated as
//     2025-03-26 per the transport spec; an unsupported value is HTTP 400.
//   - GET / answers 405 (we do not serve an SSE stream on GET). Registered
//     BEFORE auth so unauthenticated probes get 405, not a 401 challenge.
//   - notifications/initialized is a notification: HTTP 202, no JSON-RPC result.
//   - tools/call results use the spec envelope { content, structuredContent },
//     with isError: true for tool-execution failures. Protocol-level problems
//     (unknown tool, malformed params) are JSON-RPC errors, not results.

import express, { Router } from 'express';
import { enforceCanonicalPublicHost } from '../oauth/canonical-host';
import type { Request, Response } from 'express';
import { mcpOriginGuard, mcpAuthMiddleware } from './mcp-auth';
import {
  TOOL_MANIFESTS,
  SearchConnectorContentInput,
  FindTeammatesInput,
  ChatInput,
  GetChatReplyInput,
  DelegateTaskInput,
  ListConversationsInput,
  ListLearnedContextInput,
  RemoveLearnedContextInput,
} from './types';
import * as service from './service';
import { resolveMcpActor } from './actor';
import {
  AiProviderSetInput,
  CommunicationSetInput,
  getAiProvider,
  getCommunicationSettings,
  getAiProviderKeys,
  setAiProvider,
  setCommunicationSettings,
} from './settings';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { buildInstructions } from './overview';

export const mcpRouter = Router();
mcpRouter.use(enforceCanonicalPublicHost);

// Protocol versions this server supports. 2024-11-05 is deliberately absent:
// it implies the deprecated HTTP+SSE transport, which we do not implement.
// 2026-07-28 added: this server is stateless (no session store), reads the
// protocol version/capabilities from `_meta`, implements `server/discover`,
// and stamps `resultType`/`ttlMs`/`cacheScope` on results.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];
const LATEST_PROTOCOL_VERSION = '2026-07-28';

// Identity + result metadata reused across responses.
const SERVER_INFO = { name: 'liftoff', version: '1.0.0' };
// `_meta.io.modelcontextprotocol/serverInfo` on results (2026-07-28 SHOULD).
const SERVER_RESULT_META = { 'io.modelcontextprotocol/serverInfo': SERVER_INFO };
// CacheableResult hints (2026-07-28) for the fully-static list results. These
// manifests only change on deploy, so a long TTL and a shared ("public") scope
// are safe; complements (does not replace) listChanged (which we never emit).
const LIST_CACHE = { ttlMs: 3_600_000, cacheScope: 'public' as const };

// GET is not supported (no server-initiated SSE stream). The spec requires
// SSE-or-405; registered BEFORE the origin guard AND auth so every probe —
// browser or CLI, authenticated or not — gets the same 405 (audit BUG-6).
mcpRouter.get('/', (_req: Request, res: Response): void => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'Method Not Allowed: this server does not offer an SSE stream on GET' },
  });
});

// CSRF guard (header check only, no body needed) — POST path onward.
mcpRouter.use(mcpOriginGuard);
// Parse JSON body before auth middleware (auth reads req.body.id for error
// responses). 10 MB: liftoff_chat carries inline media, four items at most,
// each at most 1.5 MiB decoded (8 MiB of base64 together), and Cloud Run's
// HTTP/1.1 ceiling is 32 MB.
mcpRouter.use(express.json({ limit: '10mb' }));
mcpRouter.use(mcpAuthMiddleware);

mcpRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  // Defense-in-depth: hard-reject if auth middleware didn't populate context
  if (!req.mcpAuth) {
    res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }

  const { method, id, params } = req.body as {
    method?: string;
    id?: unknown;
    params?: Record<string, unknown>;
  };

  if (!method) {
    res.json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }

  // Stateless negotiation (MCP 2026-07-28): the protocol version and client
  // capabilities travel in `_meta` on every request — there is no initialize
  // handshake to hang them on, and each request is served independently
  // (this server keeps no session state). A client may equally send the
  // legacy MCP-Protocol-Version header or params.protocolVersion. We are
  // LIBERAL: an unknown/newer version is NOT rejected (our tool surface is
  // identical across every version we serve) — we serve at our capability
  // level and echo the negotiated version. A missing version is treated as the
  // legacy default and handled identically (no behavioral branch).
  const meta = ((req.body as { _meta?: Record<string, unknown> })._meta) ?? {};
  const headerVersion = req.headers['mcp-protocol-version'];
  const metaVersion = meta['io.modelcontextprotocol/protocolVersion'];
  const requestedVersion =
    (typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined) ||
    (typeof headerVersion === 'string' ? headerVersion : undefined) ||
    (typeof metaVersion === 'string' ? metaVersion : undefined);
  const negotiatedVersion =
    requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;
  // The `Mcp-Method` / `Mcp-Name` routing headers (2026-07-28) are accepted and
  // otherwise ignored — they exist for gateways/load-balancers, not app logic.

  switch (method) {
    case 'initialize':
      // Legacy handshake — retained for pre-2026-07-28 clients. Stateless
      // clients skip it and call server/discover (or a method) directly. Echo
      // the negotiated version and advertise capabilities.
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiatedVersion,
          serverInfo: SERVER_INFO,
          // prompts: {} — static prompts only; NO listChanged (this server
          // never emits notifications, so it must not advertise them).
          capabilities: { tools: {}, prompts: {} },
          instructions: await instructionsFor(req),
        },
      });
      return;

    case 'server/discover':
      // Stateless capability advertisement (2026-07-28) — the replacement for
      // the initialize handshake. A client MAY call this before any other
      // request to learn our supported versions, capabilities, and identity.
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          protocolVersion: negotiatedVersion,
          protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {}, prompts: {} },
          instructions: await instructionsFor(req),
          _meta: SERVER_RESULT_META,
        },
      });
      return;

    case 'notifications/initialized':
      // Notifications carry no id and must not receive a JSON-RPC result.
      res.status(202).end();
      return;

    case 'tools/list':
      res.json({
        jsonrpc: '2.0',
        id,
        result: { resultType: 'complete', ...LIST_CACHE, tools: TOOL_MANIFESTS, _meta: SERVER_RESULT_META },
      });
      return;

    case 'prompts/list':
      res.json({
        jsonrpc: '2.0',
        id,
        result: { resultType: 'complete', ...LIST_CACHE, prompts: PROMPT_MANIFESTS, _meta: SERVER_RESULT_META },
      });
      return;

    case 'prompts/get': {
      const promptName = (params?.name as string) ?? '';
      const args = (params?.arguments as Record<string, string>) ?? {};
      const prompt = buildPrompt(promptName, args);
      if (!prompt) {
        res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${promptName}` } });
        return;
      }
      res.json({ jsonrpc: '2.0', id, result: { ...prompt, resultType: 'complete', _meta: SERVER_RESULT_META } });
      return;
    }

    case 'tools/call': {
      const toolName = (params?.name as string) ?? '';
      const toolParams = (params?.arguments as Record<string, unknown>) ?? {};

      const outcome = await dispatchTool(toolName, toolParams, req);
      if ('protocolError' in outcome) {
        res.json({ jsonrpc: '2.0', id, error: outcome.protocolError });
        return;
      }
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          content: [{ type: 'text', text: JSON.stringify(outcome.data) }],
          structuredContent: outcome.data,
          _meta: SERVER_RESULT_META,
          ...(outcome.isError ? { isError: true } : {}),
        },
      });
      return;
    }

    default:
      res.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      });
  }
});

// ── Server instructions ────────────────────────────────────────────────
// The standing text lives in server-instructions.ts so the per-person
// overview (overview.ts) can append it without importing this router.

/** The instructions for THIS person: their workspace's overview ahead of the
 *  standing text. A caller with no resolvable actor, or an overview that
 *  cannot be built, gets the standing text alone. */
async function instructionsFor(req: Request): Promise<string> {
  try {
    const actor = await resolveMcpActor(req.mcpAuth!);
    if (!actor) return SERVER_INSTRUCTIONS;
    return await buildInstructions(actor);
  } catch {
    return SERVER_INSTRUCTIONS;
  }
}

// ── Static prompts (plan Phase 5 — STATIC ONLY, no per-team generation) ─

const PROMPT_MANIFESTS = [
  {
    name: 'chat',
    description: 'Send a message to one of your Liftoff agents and get its reply',
    arguments: [
      { name: 'agent', description: 'The team to contact, by name', required: true },
      { name: 'message', description: 'What to say to the team', required: true },
    ],
  },
  {
    name: 'teammates',
    description: 'List the agents in your Liftoff workspace',
    arguments: [],
  },
];

function buildPrompt(
  name: string,
  args: Record<string, string>,
): { description: string; messages: Array<{ role: string; content: { type: string; text: string } }> } | null {
  switch (name) {
    case 'chat': {
      const team = args.agent ?? args.team ?? '';
      const message = args.message ?? '';
      return {
        description: 'Send a message to a Liftoff agent',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Call liftoff_chat with team "${team}" and this message: ${message}\nReuse the returned conversationId for follow-ups with this team, and present the reply attributed to the team by name.`,
          },
        }],
      };
    }
    case 'teammates':
      return {
        description: 'List the workspace agents',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: 'Call liftoff_find_teammates with no query and present the full roster of this workspace: the platform assistants (Liftoff, the Chief AI Officer, the Insights Manager) and every agent, with each one\'s role and a one-line summary.',
          },
        }],
      };
    default:
      return null;
  }
}

// ── Tool dispatch ──────────────────────────────────────────────────────
// Returns a discriminated outcome so the router can distinguish protocol
// errors (JSON-RPC error responses) from tool results (envelope, optionally
// isError). Plan v6.1: the old shape returned validation errors INSIDE the
// result — those are lifted to protocol errors here.

type DispatchOutcome =
  | { protocolError: { code: number; message: string } }
  | { data: object; isError?: boolean };

async function dispatchTool(
  name: string,
  params: Record<string, unknown>,
  req: Request,
): Promise<DispatchOutcome> {
  const ctx = req.mcpAuth!;
  // Membership is re-read on every call and fails closed: a person removed
  // from the workspace keeps a live token until it expires, and the token
  // alone must not be enough to reach a tool.
  const actor = await resolveMcpActor(ctx);
  if (!actor) return { protocolError: { code: -32001, message: 'Not a member of this workspace' } };

  try {
    switch (name) {
      case 'liftoff_find_teammates': {
        const parsed = FindTeammatesInput.safeParse(params);
        if (!parsed.success) {
          return { protocolError: { code: -32602, message: 'Invalid params' } };
        }
        return {
          data: await service.findTeammates(
            {
              query: parsed.data.query,
              limit: parsed.data.limit,
              // Caller attribution from the MCP envelope. Today the coding-tool
              // callers (Claude Code, Codex) and collab-token callers don't
              // supply these (no agent identity to propagate), so the resulting
              // llm_usage_log row simply carries null agent_id. When
              // platform-internal callers wrap this tool they should populate the
              // caller* params so the cost row is attributed correctly.
              callerAgentId: parsed.data.callerAgentId,
              callerThreadId: parsed.data.callerThreadId,
              callerInvocationId: parsed.data.callerInvocationId,
            },
            actor,
          ),
        };
      }

      case 'liftoff_list_learned_context': {
        const parsed = ListLearnedContextInput.safeParse(params);
        if (!parsed.success) {
          return { protocolError: { code: -32602, message: 'Invalid params: exactly one of team or agentId is required' } };
        }
        return { data: await service.listLearnedContext(parsed.data, actor) };
      }

      case 'liftoff_remove_learned_context': {
        const parsed = RemoveLearnedContextInput.safeParse(params);
        if (!parsed.success) {
          return { protocolError: { code: -32602, message: 'Invalid params: exactly one of team or agentId is required, plus memoryId (uuid)' } };
        }
        return { data: await service.removeLearnedContext(parsed.data, actor) };
      }

      case 'liftoff_delegate_task': {
        const parsed = DelegateTaskInput.safeParse(params);
        if (!parsed.success) {
          return { protocolError: { code: -32602, message: 'Invalid params: exactly one of team or agentId is required, plus objective' } };
        }
        return { data: await service.delegateTask(parsed.data, actor) };
      }

      case 'liftoff_chat': {
        const parsed = ChatInput.safeParse(params);
        if (!parsed.success) {
          // The schema's own reason, so a refused attachment names the limit
          // it crossed rather than reading as a missing address.
          const detail = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
          return { protocolError: { code: -32602, message: `Invalid params: exactly one of team or agentId is required, plus message (${detail})` } };
        }
        return { data: await service.chat(parsed.data, actor) };
      }

      case 'liftoff_get_chat_reply': {
        const parsed = GetChatReplyInput.safeParse(params);
        if (!parsed.success) {
          return { protocolError: { code: -32602, message: 'Invalid params: chatRunId (uuid) is required' } };
        }
        return { data: await service.getChatReply(parsed.data, actor) };
      }

      case 'liftoff_search_connector_content': {
        const parsed = SearchConnectorContentInput.safeParse(params);
        if (!parsed.success) {
          return { protocolError: { code: -32602, message: 'Invalid params' } };
        }
        return { data: await service.searchConnectorContent(parsed.data, actor) };
      }

      case 'liftoff_list_conversations': {
        const parsed = ListConversationsInput.safeParse(params);
        if (!parsed.success) {
          return { protocolError: { code: -32602, message: 'Invalid params' } };
        }
        return { data: await service.listConversations(parsed.data, actor) };
      }

      case 'liftoff_get_settings': {
        // No input to validate: it reads the caller's own workspace and account.
        const [provider, communication] = await Promise.all([
          getAiProvider(actor),
          getCommunicationSettings(actor),
        ]);
        return { data: { aiProvider: provider, communication } };
      }

      case 'liftoff_get_ai_provider_keys': {
        // No input to validate, and no secret in either direction: the result is
        // key STATE plus the page where a key is entered in a browser.
        return { data: await getAiProviderKeys(actor) };
      }

      case 'liftoff_set_ai_provider': {
        const parsed = AiProviderSetInput.safeParse(params);
        if (!parsed.success) {
          return { protocolError: { code: -32602, message: 'Invalid params: vendor is required; agentId and confirmationId are optional' } };
        }
        // Dispatches into the existing workspace action, so the role rule and the
        // preview → confirm handshake are the ones every other surface uses. A
        // call without confirmationId previews and changes nothing.
        return { data: await setAiProvider(parsed.data, actor) };
      }

      case 'liftoff_set_communication_settings': {
        const parsed = CommunicationSetInput.safeParse(params);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
          return { protocolError: { code: -32602, message: `Invalid params: ${detail}` } };
        }
        return { data: await setCommunicationSettings(parsed.data, actor) };
      }

      default:
        return { protocolError: { code: -32601, message: `Unknown tool: ${name}` } };
    }
  } catch (error) {
    // Tool-execution failure: a result the model can read, not a protocol error.
    return { data: { error: (error as Error).message }, isError: true };
  }
}
