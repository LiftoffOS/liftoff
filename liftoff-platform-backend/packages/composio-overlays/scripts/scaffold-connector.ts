#!/usr/bin/env npx ts-node
/**
 * Deterministic scaffolder for one composio_managed connector. Emits
 * src/schemas/<slug>.ts + src/overlays/<slug>.ts from REAL Composio metadata
 * for a curated set of tools. Fabrication-proof: every slug is fetched from
 * Composio and the run FAILS if a curated slug is not real.
 *
 * Usage:  COMPOSIO_API_KEY=... npx ts-node scripts/scaffold-connector.ts \
 *           --slug <toolkitSlug> --tools <curated.json>
 *
 * curated.json:  { "REAL_VENDOR_SLUG": "stable_name", ... }
 *            or  { "REAL_VENDOR_SLUG": { "stableName": "x", "categories": ["read"] }, ... }
 *
 * The human picks the tools + stable names (the only judgment). Everything
 * else — name, description, inputSchema, real-slug validation — is copied
 * from the API. translateInput/translateOutput are left passthrough; add
 * normalization by hand later, sourced from the tool's output_parameters.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Composio } from '@composio/core';

// TOOL INDEX: the UNION of the SDK's getRawComposioTools and the REST
// GET /v3/tools?toolkit_slug= filter. Neither alone is correct, and each is
// wrong in a different, silent direction:
//
//   * REST under-reports the CURRENT catalog: 6 of zoho's 57 tools, and a flat
//     0 for zoho_books (265), zoho_desk (31), zoho_inventory (58) and
//     zoho_mail (15). It returns 200 OK with the short set, so trusting it
//     makes a live toolkit look empty and gets a working connector written off
//     as "Composio serves no tools".
//   * The SDK omits LEGACY slugs that REST still lists and that shipped
//     overlays still reference — ACTIVE_CAMPAIGN_CREATE_CONTACT,
//     CLOSE_CLOSE_CREATE_SMS, CODACY_GET_ORGANIZATION_REPOSITORIES. Trusting
//     the SDK alone flags six long-shipped overlays as fabricated.
//
// The union is a superset of both, so it still fails a genuinely invented slug
// (in neither index) while accepting every slug either index vouches for.


function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type CuratedVal = string | { stableName: string; categories?: string[] };

// Token-based so verbs at the END of a slug count too (GOOGLESLIDES_..._CREATE,
// ..._BATCH_UPDATE). A heuristic — always sanity-check categories on review, or
// set them explicitly in curated.json.
//
// The toolkit prefix is stripped FIRST. Composio slugs are TOOLKIT_VERB_NOUN and
// the toolkit half is not a verb, so tokenizing the whole slug let a vendor's
// name decide a tool's category: every FOLLOW_UP_BOSS_LIST_* read matched on
// 'FOLLOW', and JIRA_GET_ISSUE matched on 'ISSUE' once that verb was added.
// Stripping is what makes it safe to list the mutation verbs below at all.
function inferCategories(slug: string, toolkit?: string): string[] {
  // FOLLOW_UP_BOSS_LIST_DEALS + toolkit 'follow_up_boss' → LIST_DEALS.
  const prefix = (toolkit ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  let verbPart = slug.toUpperCase();
  if (prefix && verbPart.startsWith(`${prefix}_`)) verbPart = verbPart.slice(prefix.length + 1);

  const toks = new Set(verbPart.split('_'));
  const has = (...v: string[]) => v.some((x) => toks.has(x));
  if (has('DELETE', 'DESTROY', 'ARCHIVE', 'PURGE', 'TRASH', 'WIPE', 'TRUNCATE', 'CLEAR')) {
    return ['write', 'destructive'];
  }
  if (has('SEND', 'REPLY', 'DM') && has('MESSAGE', 'EMAIL', 'MAIL', 'TEXT', 'SMS', 'MMS', 'DM', 'WHATSAPP', 'NOTIFICATION', 'CHAT', 'CAMPAIGN')) {
    return ['write', 'outbound'];
  }
  if (has('CREATE', 'UPDATE', 'MODIFY', 'MERGE', 'RUN', 'ADD', 'SET', 'POST', 'PUT', 'REMOVE',
          'INSERT', 'UPSERT', 'MOVE', 'COPY', 'DUPLICATE', 'SEND', 'WRITE', 'BATCH', 'REPLACE', 'STORE',
          'MANAGE', 'TRACK', 'ASSIGN', 'TRIGGER', 'EXECUTE', 'IMPORT', 'PUBLISH', 'SUBSCRIBE', 'UNSUBSCRIBE',
          'INVITE', 'SHARE', 'APPROVE', 'REJECT', 'RESOLVE', 'ACKNOWLEDGE', 'CANCEL', 'ENABLE', 'DISABLE',
          'UPLOAD', 'CLOSE', 'RESCHEDULE', 'SYNC', 'MARK', 'TAG', 'CONVERT',
          // Mutation verbs the original list missed. Each one shipped at least
          // one live tool tagged 'read' that writes: APPEND/CLEAR (googlesheets
          // values), APPLY (excel table filter+sort persist in the workbook),
          // DECLINE (cal booking, irreversible per the vendor description).
          'APPEND', 'APPLY', 'DECLINE', 'ACCEPT', 'DRAFT', 'FORWARD', 'RENAME', 'RESTORE',
          'REVOKE', 'GRANT', 'SUBMIT', 'COMPLETE', 'START', 'STOP', 'PAUSE', 'RESUME',
          'ACTIVATE', 'DEACTIVATE', 'LOCK', 'UNLOCK', 'JOIN', 'LEAVE', 'UNARCHIVE',
          'DISCARD', 'RESET', 'PATCH', 'REFUND', 'CAPTURE', 'VOID', 'ATTACH', 'DETACH',
          'LINK', 'UNLINK', 'TRANSFER', 'SORT')) {
    return ['write'];
  }
  return ['read'];
}

interface Tool {
  slug: string;
  name: string;
  description?: string;
  input_parameters?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}


async function fetchToolIndex<T extends { slug: string }>(
  apiKey: string,
  toolkit: string,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();

  // 1. SDK — the current published catalog.
  //
  // The SDK and REST spell the input schema DIFFERENTLY: the SDK returns
  // `inputParameters`, REST returns `input_parameters`. Everything downstream
  // reads the REST spelling, so normalize here. Skipping this does not throw —
  // it silently emits `properties: {}` for every SDK-sourced tool, which is a
  // valid-looking schema that passes validate:schemas and hands the model a
  // tool it cannot pass a single argument to.
  try {
    const composio = new Composio({ apiKey });
    const tools = (await (composio.tools as unknown as {
      getRawComposioTools: (o: { toolkits: string[]; limit: number }) => Promise<
        Array<Record<string, unknown> & { slug: string }>
      >;
    }).getRawComposioTools({ toolkits: [toolkit], limit: 500 })) ?? [];
    for (const t of tools) {
      if (t.isDeprecated === true) continue;
      const normalized = {
        ...t,
        input_parameters: t.input_parameters ?? t.inputParameters,
      } as unknown as T;
      out.set(t.slug, normalized);
    }
  } catch {
    // fall through to REST; an empty union is caught by the caller
  }

  // 2. REST — smaller, but carries legacy slugs the SDK has dropped.
  let cursor: string | null | undefined;
  do {
    const url = new URL('https://backend.composio.dev/api/v3/tools');
    url.searchParams.set('toolkit_slug', toolkit);
    url.searchParams.set('limit', '500');
    if (cursor) url.searchParams.set('cursor', cursor);
    const resp = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (!resp.ok) break;
    const page = (await resp.json()) as { items?: T[]; next_cursor?: string | null };
    for (const t of page.items ?? []) if (!out.has(t.slug)) out.set(t.slug, t);
    cursor = page.next_cursor ?? null;
  } while (cursor);

  return out;
}

async function fetchTools(apiKey: string, toolkit: string): Promise<Record<string, Tool>> {
  const index = await fetchToolIndex<Tool>(apiKey, toolkit);
  if (index.size === 0) {
    throw new Error(
      `Composio returned 0 tools for toolkit '${toolkit}' from BOTH the SDK and REST. ` +
      `Confirm the slug at https://composio.dev/toolkits/${toolkit} before believing it.`,
    );
  }
  return Object.fromEntries(index);
}

const CONST = (slug: string) => slug.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

// Composio's raw input_parameters are copied verbatim, but some are malformed
// for the LLM tool API in ways that make tenant-runtime's cold-start validator
// (and OpenAI/Anthropic at request time) reject them. Sanitize the three known
// classes recursively so a scaffold never ships a boot-breaking schema:
//   1. `pattern` that won't compile as a JS RegExp under the `u` flag
//      (Python-flavored escapes like `\-`, `\{`, `\}`). Drop it — it's an
//      advisory hint; the vendor validates server-side and `examples` remain.
//   2. `nullable` on a node with no `type` — ajv rejects it. Adopt a `type`
//      from `format` when obvious (uri/date-time/email → string), else drop
//      the inert `nullable`.
//   3. `type: 'array'` with no `items` — OpenAI rejects bare arrays. Default
//      to `items: {}` ("any"), the sanctioned catch-all.
function sanitizeSchemaNode(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;

  if (typeof n.pattern === 'string') {
    try {
      new RegExp(n.pattern, 'u');
    } catch {
      delete n.pattern;
    }
  }

  if ('nullable' in n && !('type' in n)) {
    const fmt = typeof n.format === 'string' ? n.format : '';
    if (['uri', 'url', 'date-time', 'date', 'time', 'email', 'uuid', 'hostname'].includes(fmt)) {
      n.type = 'string';
    } else {
      delete n.nullable;
    }
  }

  if (n.type === 'array' && n.items === undefined) {
    n.items = {};
  }

  if (n.properties && typeof n.properties === 'object') {
    for (const child of Object.values(n.properties as Record<string, unknown>)) sanitizeSchemaNode(child);
  }
  if (n.items && typeof n.items === 'object') sanitizeSchemaNode(n.items);
}

function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  for (const child of Object.values(properties)) sanitizeSchemaNode(child);
  return properties;
}

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const slug = arg('slug');
  const toolsPath = arg('tools');
  if (!apiKey || !slug || !toolsPath) {
    console.error('need COMPOSIO_API_KEY + --slug + --tools <curated.json>');
    process.exit(2);
  }
  const curated = JSON.parse(readFileSync(resolve(toolsPath), 'utf8')) as Record<string, CuratedVal>;
  const real = await fetchTools(apiKey, slug);

  const missing = Object.keys(curated).filter((s) => !real[s]);
  if (missing.length) {
    console.error(`FABRICATED / not in Composio '${slug}':\n${missing.map((m) => '  - ' + m).join('\n')}`);
    process.exit(1);
  }

  const schemaEntries = Object.entries(curated).map(([vslug, val]) => {
    const t = real[vslug];
    const cats = typeof val === 'object' && val.categories ? val.categories : inferCategories(vslug, slug);
    const ip = t.input_parameters ?? { type: 'object', properties: {} };
    return {
      slug: vslug,
      name: t.name,
      description: (t.description ?? '').trim(),
      inputSchema: { type: 'object', properties: sanitizeProperties(ip.properties ?? {}), ...(ip.required ? { required: ip.required } : {}) },
      categories: cats,
    };
  });

  // A handful of genuinely parameterless tools exist (ZOHO_LIST_MODULES,
  // ZOHO_BOOKS_LIST_ORGANIZATIONS). ALL of them empty is not that — it is the
  // SDK/REST input-schema spelling mismatch (`inputParameters` vs
  // `input_parameters`), which emits tools the model can call but cannot pass a
  // single argument to, and which validate:schemas accepts as valid.
  const empties = schemaEntries.filter((e) => Object.keys(e.inputSchema.properties).length === 0);
  if (empties.length === schemaEntries.length && schemaEntries.length > 1) {
    throw new Error(
      `EVERY curated tool for '${slug}' resolved to an empty input schema — that is a ` +
      `fetch/shape bug in fetchToolIndex, not ${schemaEntries.length} parameterless tools.`,
    );
  }
  if (empties.length) {
    console.error(`  note: ${empties.length} parameterless tool(s): ${empties.map((e) => e.slug).join(', ')}`);
  }

  const overlayEntries = Object.entries(curated).map(([vslug, val]) => {
    const stableName = typeof val === 'string' ? val : val.stableName;
    const cats = typeof val === 'object' && val.categories ? val.categories : inferCategories(vslug, slug);
    return `  ${vslug}: { stableName: '${stableName}', categoryOverrides: ${JSON.stringify(cats)} },`;
  });

  const C = CONST(slug);
  const schemaFile = `// ${slug} Composio toolkit schemas. Curated subset of Composio's REAL tools
// (validated by validate:slugs). Generated by scaffold-connector.ts — do not hand-edit slugs.

import type { ComposioVendorSchema } from '../types';

export const ${C}_SCHEMAS: ComposioVendorSchema[] = ${JSON.stringify(schemaEntries, null, 2)};
`;
  const overlayFile = `// ${slug} overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ${C}_OVERLAYS: Record<string, ComposioToolOverlay> = {
${overlayEntries.join('\n')}
};

export const ${C}_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
`;
  writeFileSync(resolve(__dirname, `../src/schemas/${slug}.ts`), schemaFile, 'utf8');
  writeFileSync(resolve(__dirname, `../src/overlays/${slug}.ts`), overlayFile, 'utf8');

  console.error(`wrote src/schemas/${slug}.ts + src/overlays/${slug}.ts (${schemaEntries.length} tools)`);
  console.error(`\nRegister:\n  schemas/index.ts:  import { ${C}_SCHEMAS } from './${slug}';  +  ${slug}: ${C}_SCHEMAS,`);
  console.error(`  overlays/index.ts: import { ${C}_OVERLAYS, ${C}_HISTORY_MAPPINGS } from './${slug}';  +  ${slug}: ${C}_OVERLAYS,  +  history: ${slug}: ${C}_HISTORY_MAPPINGS,`);
}

main().catch((e) => { console.error(`Fatal: ${(e as Error).message}`); process.exit(1); });
