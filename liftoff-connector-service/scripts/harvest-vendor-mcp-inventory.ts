// harvest-vendor-mcp-inventory.ts
//
// CLI script: capture a vendor-hosted MCP server's tool inventory into
// src/catalog/vendor-mcp-inventory/<type>.json WITHOUT a vendor account, key or
// token. The inventory is what classify-connector-tools.ts --from-inventory
// classifies, so a connector's HITL seed exists BEFORE the first customer
// connects.
//
// Four adapters, one per kind of public surface a vendor exposes:
//
//   --source live   initialize + tools/list against the catalog mcpUrl with a
//                   placeholder Bearer (no real credential). Servers that list
//                   their tools before authorising a call answer this; the
//                   annotations they publish are captured verbatim. For a
//                   META-TOOL server (omnisend) the operations behind `execute`
//                   are expanded from `tools/call search {}` into
//                   `execute:<name>` rows with their HTTP method and path.
//   --source docs   fetch the vendor's public tool reference page, reduce it to
//                   text, and have the platform-backend LLM relay return the
//                   tools it STATES (name, description, annotations, method and
//                   path when the page gives them) and nothing it does not.
//                   With --read-only-scopes the record is labelled
//                   `oauth_scopes`: the catalog entry's DCR scopes are checked
//                   to be `*:read` only, which proves every tool on the server
//                   is a read whatever its name (salesloft).
//   --source oss    clone the vendor's open-source server at a pinned commit,
//                   build it, start it on stdio with a placeholder token, and
//                   run tools/list. Never calls the vendor API.
//   --source api-reference
//                   for a vendor whose MCP mirrors its public API and publishes
//                   no tool list: read the API reference index (an llms.txt whose
//                   entries point at per-operation markdown pages embedding the
//                   OpenAPI definition) and record one tool per operation, named
//                   by the vendor's own reference slug, with its method and path.
//                   The names are the closest public identifier and are diffed
//                   against cached_vendor_mcp_tools after the first real
//                   connection.
//
// Usage:
//   npm run harvest:vendor-mcp -- --connector typefully --source live
//   npm run harvest:vendor-mcp -- --connector klaviyo --source docs --url <docs page>
//   npm run harvest:vendor-mcp -- --connector salesloft --source docs --read-only-scopes --url <docs page>
//   npm run harvest:vendor-mcp -- --connector webflow --source oss --repo webflow/mcp-server \
//       --commit <sha> --placeholder-env WEBFLOW_TOKEN=x
//   npm run harvest:vendor-mcp -- --connector livestorm --source api-reference --url <llms.txt>
//   ... --out <file>   write a cross-check harvest somewhere other than the committed inventory
//
// Required env vars (docs adapter only): PLATFORM_BACKEND_URL, CONNECTOR_SERVICE_TOKEN —
// the same relay classify-connector-tools.ts uses.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StreamableHttpTransport, CLIENT_INFO, CLIENT_PROTOCOL_VERSION } from '@liftoffos/mcp-transports';
import { CONNECTORS } from '../src/catalog/connectors';

// ── Inventory shape ──────────────────────────────────────────────────────────

export interface VendorToolInventory {
  connectorType: string;
  harvestedAt: string;               // ISO date
  source: 'live_unauthenticated' | 'vendor_docs' | 'vendor_oss' | 'vendor_api_reference' | 'oauth_scopes';
  sourceUrl: string;
  /** For meta-tool servers: the tool whose argument names the operation, and that argument. */
  operationKey?: { tool: string; arg: string };
  tools: Array<{
    name: string;                    // bare vendor tool name, or `<tool>:<operation>` under operationKey
    description: string;
    inputSchema?: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
    httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path?: string;
  }>;
}

type InventoryTool = VendorToolInventory['tools'][number];

const INVENTORY_DIR = path.resolve(__dirname, '../src/catalog/vendor-mcp-inventory');
const PLACEHOLDER_BEARER = 'x';
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Meta-tool servers: one tool whose ARGUMENT names the operation. Keyed by
// connector type; the argument name is read from the live tool's inputSchema at
// harvest time and pinned here so classify + the runtime gate agree on it.
const META_TOOL_SERVERS: Record<string, { tool: string; arg: string; searchTool: string }> = {
  omnisend: { tool: 'execute', arg: 'tool_name', searchTool: 'search' },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickAnnotations(raw: unknown): InventoryTool['annotations'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  const out: NonNullable<InventoryTool['annotations']> = {};
  for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof a[k] === 'boolean') out[k] = a[k] as boolean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMethod(raw: unknown): InventoryTool['httpMethod'] | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = raw.toUpperCase();
  return HTTP_METHODS.has(m) ? (m as InventoryTool['httpMethod']) : undefined;
}

/** Write the record — to the committed inventory by default, or to `--out`
 *  for a cross-check harvest (a second source for the same type) that must
 *  not replace the one the seed was classified from. */
function writeInventory(inv: VendorToolInventory, out?: string): string {
  const file = out ? path.resolve(out) : path.join(INVENTORY_DIR, `${inv.connectorType}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(inv, null, 2) + '\n', 'utf8');
  return file;
}

/** MCP tools/list entries, as any adapter sees them. */
interface RawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: unknown;
}

function toInventoryTools(raw: RawTool[]): InventoryTool[] {
  return raw.map((t) => ({
    name: t.name,
    description: (t.description ?? '').trim(),
    ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
    ...(pickAnnotations(t.annotations) ? { annotations: pickAnnotations(t.annotations) } : {}),
  }));
}

// ── live adapter ─────────────────────────────────────────────────────────────
//
// The handshake is driven explicitly rather than through createTransport's
// auto-detection: a server that answers server/discover is treated as stateless
// there and never receives notifications/initialized, and omnisend refuses
// every method until it has. initialize is a raw POST so the session id the
// server returns can be handed to the library transport, which then carries it
// on tools/list and tools/call and reads the SSE-or-JSON response for us.

async function openLiveSession(endpointUrl: string): Promise<StreamableHttpTransport> {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${PLACEHOLDER_BEARER}`,
  };
  const init = await fetch(endpointUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: CLIENT_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!init.ok) {
    throw new Error(`initialize failed: HTTP ${init.status} ${(await init.text().catch(() => '')).slice(0, 200)}`);
  }
  // Drain the body: the result itself is not needed, only the session header.
  await init.text().catch(() => '');
  const sessionId = init.headers.get('mcp-session-id');
  await fetch(endpointUrl, {
    method: 'POST',
    headers: { ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined); // some servers 202, some 405; neither matters
  return new StreamableHttpTransport({
    config: { endpointUrl, authType: 'bearer_token', bearerToken: PLACEHOLDER_BEARER, timeout: 30_000 },
    sessionId,
  });
}

async function listAllTools(transport: StreamableHttpTransport): Promise<RawTool[]> {
  const out: RawTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await transport.request<{ tools?: RawTool[]; nextCursor?: string }>(
      'tools/list',
      cursor ? { cursor } : {},
    );
    if (result.tools?.length) out.push(...result.tools);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return out;
}

/** The text a tools/call returned, whatever wrapper it came in. */
function callText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  const text = (r.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  if (text) return text;
  return r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : JSON.stringify(result);
}

async function harvestLive(connectorType: string): Promise<VendorToolInventory> {
  const def = CONNECTORS[connectorType];
  if (!def?.mcp || def.mcp.kind !== 'vendor_hosted') {
    throw new Error(`"${connectorType}" is not a vendor_hosted connector; the live adapter needs a catalog mcpUrl`);
  }
  if (def.mcp.transport !== 'streamable-http') {
    throw new Error(`"${connectorType}" uses ${def.mcp.transport}; the live adapter speaks streamable-http only`);
  }
  const endpointUrl = def.mcp.mcpUrl;
  console.error(`live: ${endpointUrl}`);
  const transport = await openLiveSession(endpointUrl);
  try {
    const raw = await listAllTools(transport);
    if (raw.length === 0) throw new Error('tools/list returned no tools');
    const tools = toInventoryTools(raw);
    const inv: VendorToolInventory = {
      connectorType,
      harvestedAt: new Date().toISOString().slice(0, 10),
      source: 'live_unauthenticated',
      sourceUrl: endpointUrl,
      tools,
    };

    const meta = META_TOOL_SERVERS[connectorType];
    if (meta) {
      const executeTool = raw.find((t) => t.name === meta.tool);
      const props = (executeTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      if (!(meta.arg in props)) {
        throw new Error(
          `${connectorType}: meta-tool ${meta.tool} does not take "${meta.arg}" (has ${Object.keys(props).join(', ')}); ` +
          'fix META_TOOL_SERVERS before writing an inventory the runtime gate cannot resolve',
        );
      }
      const searchResult = await transport.request<unknown>('tools/call', { name: meta.searchTool, arguments: {} });
      const parsed = JSON.parse(callText(searchResult)) as { tools?: Array<Record<string, unknown>> };
      const ops = parsed.tools ?? [];
      if (ops.length === 0) throw new Error(`${meta.searchTool} returned no operations`);
      for (const op of ops) {
        if (typeof op.name !== 'string') continue;
        tools.push({
          name: `${meta.tool}:${op.name}`,
          description: String(op.description ?? op.title ?? '').trim(),
          ...(normalizeMethod(op.method) ? { httpMethod: normalizeMethod(op.method) } : {}),
          ...(typeof op.path === 'string' ? { path: op.path } : {}),
        });
      }
      inv.operationKey = { tool: meta.tool, arg: meta.arg };
      console.error(`live: ${meta.searchTool} expanded ${ops.length} operations behind ${meta.tool}`);
    }
    return inv;
  } finally {
    transport.close();
  }
}

// ── docs adapter ─────────────────────────────────────────────────────────────

const DOCS_TEXT_BUDGET = 200_000; // characters handed to the relay

function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(td|th)>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
  return s.trim();
}

const DOCS_EXTRACTION_PROMPT = `You are extracting an MCP server's TOOL INVENTORY from a vendor's public documentation page.

Return every tool the page states, exactly as the page names it. Rules:
- Copy each tool NAME verbatim (keep the vendor's casing and separators). Do not invent, rename, pluralise or normalise names.
- The DESCRIPTION is the page's own wording for that tool, trimmed. If the page gives none, use an empty string.
- Set annotations ONLY when the page explicitly states them (read-only / destructive / idempotent / open-world markers, columns or badges). Otherwise omit annotations entirely.
- Set httpMethod and path ONLY when the page states the HTTP method or API path a tool maps to. Otherwise omit them.
- A meta-tool server (search / execute / list_tools / get_schema and the like) is listed as those tools; do not expand what the page does not enumerate.
- Do not include prose, headings, prerequisites, scopes, or client setup steps as tools.
- If the page states no tools, return an empty list.`;

/** True when every scope the catalog entry requests is a read scope, so the
 *  token the connector holds cannot write and every tool is a read. */
function scopesAreReadOnly(connectorType: string): boolean {
  const auth = CONNECTORS[connectorType]?.auth;
  if (!auth || auth.kind !== 'dcr_oauth') return false;
  return auth.scopes.length > 0 && auth.scopes.every((scope) => /:read$/.test(scope));
}

async function harvestDocs(connectorType: string, url: string, readOnlyScopes = false): Promise<VendorToolInventory> {
  if (readOnlyScopes && !scopesAreReadOnly(connectorType)) {
    throw new Error(
      `--read-only-scopes: "${connectorType}" requests scopes that are not all *:read ` +
      `(${JSON.stringify(CONNECTORS[connectorType]?.auth)}); the scope proof does not hold`,
    );
  }
  const pbUrl = process.env['PLATFORM_BACKEND_URL'];
  const serviceToken = process.env['CONNECTOR_SERVICE_TOKEN'];
  if (!pbUrl || !serviceToken) {
    throw new Error('docs adapter needs PLATFORM_BACKEND_URL and CONNECTOR_SERVICE_TOKEN (the classify:tools relay env)');
  }
  console.error(`docs: fetching ${url}`);
  // A client-rendered help centre (Salesforce Experience sites) serves its
  // article body only to a crawler user agent, so a page that reduces to
  // nothing is fetched once more as one before being given up on.
  let text = '';
  for (const userAgent of [
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ]) {
    const resp = await fetch(url, {
      headers: { 'user-agent': userAgent, accept: 'text/html,text/markdown,text/plain,text/csv,*/*' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`docs fetch failed: HTTP ${resp.status}`);
    const body = await resp.text();
    const contentType = resp.headers.get('content-type') ?? '';
    text = /html/i.test(contentType) || /^\s*</.test(body) ? htmlToText(body) : body;
    if (text.length >= 200 && text.split(/\s+/).length >= 100) break;
  }
  if (text.length < 200) throw new Error(`docs page reduced to ${text.length} characters of text — it is not server-rendered; find a markdown or llms.txt source`);
  const clipped = text.length > DOCS_TEXT_BUDGET ? text.slice(0, DOCS_TEXT_BUDGET) : text;
  console.error(`docs: ${text.length} characters of text${clipped.length < text.length ? ` (clipped to ${DOCS_TEXT_BUDGET})` : ''}`);

  const relayBody = {
    request: {
      model: 'claude-sonnet-4-6',
      maxTokens: 16_000,
      messages: [
        { role: 'system', content: DOCS_EXTRACTION_PROMPT },
        { role: 'user', content: `Vendor: ${CONNECTORS[connectorType]?.displayName ?? connectorType}\nPage: ${url}\n\n${clipped}` },
      ],
      tools: [
        {
          name: 'record_tool_inventory',
          description: 'Record the tools the page states',
          input_schema: {
            type: 'object',
            properties: {
              tools: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    annotations: {
                      type: 'object',
                      properties: {
                        readOnlyHint: { type: 'boolean' },
                        destructiveHint: { type: 'boolean' },
                        idempotentHint: { type: 'boolean' },
                        openWorldHint: { type: 'boolean' },
                      },
                    },
                    httpMethod: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                    path: { type: 'string' },
                  },
                  required: ['name', 'description'],
                },
              },
            },
            required: ['tools'],
          },
        },
      ],
      toolChoice: { name: 'record_tool_inventory' },
    },
    usageContext: { purpose: 'tool_classification' },
  };
  const relay = await fetch(`${pbUrl}/api/internal/llm/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-auth': serviceToken },
    body: JSON.stringify(relayBody),
    signal: AbortSignal.timeout(300_000),
  });
  if (!relay.ok) throw new Error(`LLM relay error ${relay.status}: ${(await relay.text()).slice(0, 300)}`);
  const data = (await relay.json()) as { toolCalls?: Array<{ name: string; input: { tools?: Array<Record<string, unknown>> } }> };
  const call = data.toolCalls?.find((c) => c.name === 'record_tool_inventory');
  const extracted = call?.input?.tools ?? [];
  const seen = new Set<string>();
  const tools: InventoryTool[] = [];
  for (const t of extracted) {
    if (typeof t.name !== 'string' || !t.name.trim() || seen.has(t.name)) continue;
    seen.add(t.name);
    const annotations = pickAnnotations(t.annotations);
    const httpMethod = normalizeMethod(t.httpMethod);
    tools.push({
      name: t.name.trim(),
      description: typeof t.description === 'string' ? t.description.trim() : '',
      ...(annotations ? { annotations } : {}),
      ...(httpMethod ? { httpMethod } : {}),
      ...(typeof t.path === 'string' && t.path.trim() ? { path: t.path.trim() } : {}),
    });
  }
  if (tools.length === 0) throw new Error('the relay found no tools on the page; check the page states a tool list');
  console.error(`docs: ${tools.length} tools extracted${readOnlyScopes ? ' (read-only scopes: every tool is a read)' : ''}`);
  return {
    connectorType,
    harvestedAt: new Date().toISOString().slice(0, 10),
    source: readOnlyScopes ? 'oauth_scopes' : 'vendor_docs',
    sourceUrl: url,
    tools,
  };
}

// ── oss adapter ──────────────────────────────────────────────────────────────

/** Minimal newline-delimited JSON-RPC client over a child process's stdio. */
async function stdioToolsList(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<RawTool[]> {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', (d) => {
    buffer += String(d);
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = typeof msg.id === 'number' ? msg.id : undefined;
        if (id !== undefined && pending.has(id)) { pending.get(id)!(msg); pending.delete(id); }
      } catch { /* non-JSON stdout noise */ }
    }
  });
  const send = (msg: Record<string, unknown>): void => { child.stdin.write(JSON.stringify(msg) + '\n'); };
  const request = (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; stderr: ${stderr.slice(-400)}`)); }, 60_000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: '2.0', id, method, params });
    });
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harvest', version: '0.1' } });
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools: RawTool[] = [];
    let cursor: string | undefined;
    for (let id = 2; id < 52; id++) {
      const res = await request(id, 'tools/list', cursor ? { cursor } : {});
      if (res.error) throw new Error(`tools/list error: ${JSON.stringify(res.error)}`);
      const result = res.result as { tools?: RawTool[]; nextCursor?: string } | undefined;
      if (result?.tools?.length) tools.push(...result.tools);
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  } finally {
    child.kill('SIGTERM');
  }
}

async function harvestOss(
  connectorType: string,
  repo: string,
  commit: string | undefined,
  placeholderEnv: Record<string, string>,
  entry: string | undefined,
): Promise<VendorToolInventory> {
  const dir = mkdtempSync(path.join(tmpdir(), `harvest-${connectorType}-`));
  const repoUrl = `https://github.com/${repo}.git`;
  try {
    console.error(`oss: cloning ${repoUrl}${commit ? ` @ ${commit}` : ''}`);
    execFileSync('git', ['clone', '--quiet', repoUrl, dir], { stdio: 'inherit' });
    if (commit) execFileSync('git', ['checkout', '--quiet', commit], { cwd: dir, stdio: 'inherit' });
    const pinned = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    // `npm ci` needs a package-lock; a vendor on pnpm or yarn ships none, and
    // for a throwaway tree a plain install of the declared ranges is what
    // "the vendor's dependencies" means anyway.
    const hasNpmLock = existsSync(path.join(dir, 'package-lock.json'));
    console.error(hasNpmLock ? 'oss: npm ci' : 'oss: npm install (no package-lock in the repo)');
    execFileSync(
      'npm',
      hasNpmLock
        ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--silent']
        : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--silent'],
      { cwd: dir, stdio: 'inherit' },
    );
    console.error('oss: npm run build');
    execFileSync('npm', ['run', 'build', '--silent'], { cwd: dir, stdio: 'inherit' });
    const pkg = JSON.parse(execFileSync('cat', ['package.json'], { cwd: dir }).toString()) as { bin?: string | Record<string, string>; main?: string };
    const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin ? Object.values(pkg.bin)[0] : undefined;
    const script = entry ?? binEntry ?? pkg.main;
    if (!script) throw new Error('cannot find the server entry (no bin/main); pass --entry <path>');
    console.error(`oss: node ${script} with ${Object.keys(placeholderEnv).join(', ') || 'no'} placeholder env`);
    const raw = await stdioToolsList('node', [script], dir, placeholderEnv);
    if (raw.length === 0) throw new Error('tools/list returned no tools');
    return {
      connectorType,
      harvestedAt: new Date().toISOString().slice(0, 10),
      source: 'vendor_oss',
      sourceUrl: `${repoUrl.replace(/\.git$/, '')}/tree/${pinned}`,
      tools: toInventoryTools(raw),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── api-reference adapter ────────────────────────────────────────────────────
//
// readme.io-hosted references publish an llms.txt index whose "## API
// Reference" entries link one markdown page per operation, and each page
// embeds that operation's OpenAPI definition. One tool per operation: the
// vendor's reference slug is the name (`get_events-id`), the summary is the
// description, and the method and path are read from the definition itself.

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36', accept: 'text/markdown,text/plain,*/*' },
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status} for ${url}`);
  return resp.text();
}

async function harvestApiReference(connectorType: string, indexUrl: string): Promise<VendorToolInventory> {
  console.error(`api-reference: fetching ${indexUrl}`);
  const index = await fetchText(indexUrl);
  const section = index.split(/^## /m).find((part) => /^API Reference/i.test(part));
  if (!section) throw new Error('no "## API Reference" section in the index');
  const entries = [...section.matchAll(/^- \[([^\]]+)\]\((https?:[^)\s]+?)(?:\.md)?\)(?::\s*(.*))?$/gm)]
    .map((m) => ({ title: m[1]!.trim(), url: m[2]!, blurb: (m[3] ?? '').trim() }));
  if (entries.length === 0) throw new Error('the API Reference section lists no operations');
  console.error(`api-reference: ${entries.length} operations listed`);

  const tools: InventoryTool[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const slug = entry.url.replace(/\/+$/, '').split('/').pop() ?? '';
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    let httpMethod: InventoryTool['httpMethod'] | undefined;
    let apiPath: string | undefined;
    let summary = '';
    try {
      const page = await fetchText(`${entry.url}.md`);
      const embedded = /```json\n(\{[\s\S]*?\n)```/.exec(page);
      if (embedded) {
        const spec = JSON.parse(embedded[1]!) as { paths?: Record<string, Record<string, { summary?: string; description?: string }>> };
        for (const [p, ops] of Object.entries(spec.paths ?? {})) {
          for (const [method, op] of Object.entries(ops)) {
            const m = normalizeMethod(method);
            if (!m) continue;
            httpMethod = m;
            apiPath = p;
            summary = (op.summary ?? op.description ?? '').trim();
          }
        }
      }
    } catch (err) {
      console.error(`api-reference: ${slug}: ${(err as Error).message} (recording the index entry alone)`);
    }
    // The slug's leading token states the method when the page could not be read.
    if (!httpMethod) httpMethod = normalizeMethod(slug.split(/[_-]/)[0]);
    // An index entry with no method is a guide page (authentication, rate
    // limits), not an operation.
    if (!httpMethod) continue;
    tools.push({
      name: slug,
      description: summary || entry.blurb || entry.title,
      ...(httpMethod ? { httpMethod } : {}),
      ...(apiPath ? { path: apiPath } : {}),
    });
  }
  return {
    connectorType,
    harvestedAt: new Date().toISOString().slice(0, 10),
    source: 'vendor_api_reference',
    sourceUrl: indexUrl,
    tools,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      connector:         { type: 'string' },
      source:            { type: 'string' },
      url:               { type: 'string' },
      repo:              { type: 'string' },
      commit:            { type: 'string' },
      entry:             { type: 'string' },
      'placeholder-env': { type: 'string', multiple: true },
      out:               { type: 'string' },
      'read-only-scopes': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const connectorType = values.connector;
  const source = values.source;
  if (!connectorType || !source) {
    console.error('Usage: harvest:vendor-mcp -- --connector <type> --source <live|docs|oss|api-reference> [--url <docs page | llms.txt>] [--repo <owner/name>] [--commit <sha>] [--placeholder-env NAME=value] [--read-only-scopes] [--out <file>]');
    process.exit(2);
  }
  if (!CONNECTORS[connectorType]) {
    console.error(`Error: "${connectorType}" is not in the CONNECTORS catalog.`);
    process.exit(1);
  }

  let inventory: VendorToolInventory;
  if (source === 'live') {
    inventory = await harvestLive(connectorType);
  } else if (source === 'docs') {
    if (!values.url) { console.error('Error: --source docs needs --url <docs page>'); process.exit(1); }
    inventory = await harvestDocs(connectorType, values.url, values['read-only-scopes']);
  } else if (source === 'api-reference') {
    if (!values.url) { console.error('Error: --source api-reference needs --url <llms.txt index>'); process.exit(1); }
    inventory = await harvestApiReference(connectorType, values.url);
  } else if (source === 'oss') {
    if (!values.repo) { console.error('Error: --source oss needs --repo <owner/name>'); process.exit(1); }
    const env: Record<string, string> = {};
    for (const kv of values['placeholder-env'] ?? []) {
      const eq = kv.indexOf('=');
      if (eq <= 0) { console.error(`Error: --placeholder-env expects NAME=value, got "${kv}"`); process.exit(1); }
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    inventory = await harvestOss(connectorType, values.repo, values.commit, env, values.entry);
  } else {
    console.error(`Error: unknown --source "${source}" (live | docs | oss | api-reference)`);
    process.exit(1);
  }

  const file = writeInventory(inventory, values.out);
  console.error(`wrote ${path.relative(process.cwd(), file)} (${inventory.tools.length} tools, source=${inventory.source})`);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
