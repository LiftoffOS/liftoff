// Locus Parse catalog generation — the resold public-data lane, from the
// account's own catalog rather than by hand.
//
//   LOCUS_API_KEY=… npm run gen:locus-parse
//   LOCUS_API_KEY=… npm run gen:locus-parse -- --pb-migration /path/to/migrations/NNN_locus_parse_classification.sql
//   npm run gen:locus-parse -- --catalog /path/to/catalog.json        (no key)
//
// The --catalog form reads the account's provider documents from a file
// instead of fetching them, so the one step that needs the workspace key is
// separable from the generation. The key can then stay where it belongs --
// Secret Manager, read by a job that dumps the documents -- and the rendering
// is reproducible by anyone from a file they can read and diff. The file is
// `{ "<provider>": <the /credits/catalog/{provider} response>, … }` and must
// cover every provider in the allowlist; a missing one is an error rather
// than a silent omission, because a quietly short catalog renders a quietly
// short registry. The schema-source fetch is unauthenticated and still runs.
//
// Reads every provider in src/catalog/locus-parse-allowlist.ts from the Locus
// account (`GET /api/credits/catalog/{provider}`: executable input schemas,
// listed prices, enablement) and writes src/catalog/generated/locus-parse.ts as
// COMMITTED, review-able source: one capability-named function per endpoint,
// the provider's own argument names, the listed price, the dispatch slug.
// With --pb-migration it also writes platform-backend's classification rows
// for the same functions (reviewed reads, the hash of each description as the
// row's hash), so the two sides cannot disagree about a name or a description.
// Regeneration + a diff is the maintenance loop; nothing here runs on a
// schedule and nothing here enables an endpoint — a disabled provider is
// reported and left out, since Locus would answer ENDPOINT_DISABLED.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { LOCUS_PARSE_ALLOWLIST, type LocusParseProvider } from '../src/catalog/locus-parse-allowlist';
import {
  splitLocusSchemas,
  testInputFieldsFor,
  type GeneratedSchema,
  type ParseMarketplaceDoc,
} from '../src/catalog/locus-parse-schemas';

const LOCUS_API_BASE = 'https://api.paywithlocus.com/api';
const OUT = path.resolve(__dirname, '../src/catalog/generated/locus-parse.ts');
/** OpenAI's tool-name bound is 64; every vendor's is at least that. */
const MAX_NAME = 60;
const MAX_DESCRIPTION = 480;

interface LocusEndpoint {
  slug: string;
  name?: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  /** Where Locus got this endpoint's schema — Parse's own marketplace entry,
   *  which is the only place that says whether a value list is the field's
   *  real domain or the inputs Parse tests the scraper with. */
  schemaSource?: string;
  effectiveUsd?: string | number;
  baseUsdc?: string | number;
  enabled?: boolean;
  dynamic?: boolean;
}
interface LocusProviderDoc {
  provider?: { provider: string; name: string; description?: string; endpoints?: LocusEndpoint[] };
}

interface Generated {
  name: string;
  description: string;
  /** What the model is offered: advisory enums relaxed to examples. */
  inputSchema: GeneratedSchema;
  /** What Locus will actually accept, when that is narrower. Never shown to
   *  a model; the backend validates against it before dispatching. */
  routingSchema: GeneratedSchema | null;
  /** The fields whose enum was reclassified, for the run report. */
  relaxed: string[];
  slug: string;
  priceUsd: number;
  bucket: string;
}

async function fetchProvider(provider: string, key: string): Promise<LocusProviderDoc> {
  const r = await fetch(`${LOCUS_API_BASE}/credits/catalog/${encodeURIComponent(provider)}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`${provider}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as LocusProviderDoc;
}

/** Parse's marketplace metadata for one endpoint's `schemaSource`, fetched
 *  once per URL. Null when it cannot be had — the generator then leaves every
 *  enum exactly as Locus published it, which is the conservative direction
 *  and the behaviour this replaces. */
const parseDocs = new Map<string, ParseMarketplaceDoc | null>();
async function fetchSchemaSource(url: string | undefined, report: string[]): Promise<ParseMarketplaceDoc | null> {
  if (!url) return null;
  const hit = parseDocs.get(url);
  if (hit !== undefined) return hit;
  let doc: ParseMarketplaceDoc | null = null;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (r.ok) doc = (await r.json()) as ParseMarketplaceDoc;
    else report.push(`NO SCHEMA SOURCE  ${url} — HTTP ${r.status}; enums left exactly as published`);
  } catch (err) {
    report.push(`NO SCHEMA SOURCE  ${url} — ${(err as Error).message}; enums left exactly as published`);
  }
  parseDocs.set(url, doc);
  return doc;
}

/** The vendor's own names replaced with a neutral phrase, wherever they
 *  appear in the vendor's prose — including possessives and domains. */
function scrub(text: string, brands: string[]): string {
  let out = text;
  for (const b of [...brands, 'locus', 'parse.bot', 'parsebot'].sort((x, y) => y.length - x.length)) {
    const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?:https?://)?(?:www\\.)?\\b${escaped}(?:'s|\\.[a-z]{2,6})?\\b/?`, 'gi'), 'this source');
  }
  return out.replace(/\s+/g, ' ').replace(/\bthis source(?:'s)? this source\b/gi, 'this source').trim();
}

/** A boundary that `\\b` is not: an underscore is a word character to the
 *  regex engine and a separator in a function name, so `get_carfax_value`
 *  must fail this check. */
function brandRe(b: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ ._-]+/g, '[ ._-]*')}(?=$|[^a-z0-9])`, 'i');
}

function assertNoBrand(text: string, brands: string[], where: string): void {
  for (const b of brands) {
    if (brandRe(b).test(text)) {
      throw new Error(`${where}: still names "${b}" after scrubbing: ${text.slice(0, 120)}`);
    }
  }
}

function snake(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** The endpoint's own words with the vendor's taken out of them: a vendor
 *  names its endpoints after itself (`get_carfax_value`), and the function's
 *  name is the capability's. */
function unbrand(endpoint: string, brands: string[]): string {
  let out = endpoint;
  for (const b of [...brands].sort((x, y) => y.length - x.length)) {
    out = out.replace(new RegExp(`(^|_)${snake(b)}(?=_|$)`, 'gi'), '$1');
  }
  return out.replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'value';
}

/** The registry's JSON-schema shape is a narrow one (type, description,
 *  items, properties, enum). Anything else the vendor wrote — a default, a
 *  bound, a format — is folded into the description so the model still
 *  reads it. */
function projectProperty(p: Record<string, unknown>, brands: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = p.type ?? (p.enum ? 'string' : 'string');
  out.type = type;
  const notes: string[] = [];
  if (p.default !== undefined) notes.push(`default ${JSON.stringify(p.default)}`);
  if (p.minimum !== undefined) notes.push(`at least ${p.minimum}`);
  if (p.maximum !== undefined) notes.push(`at most ${p.maximum}`);
  if (p.format) notes.push(`format ${p.format}`);
  if (typeof p.description === 'string' || notes.length) {
    // Scrubbed AFTER the notes are folded in: a vendor's default is often its
    // own URL.
    out.description = scrub([String(p.description ?? ''), notes.length ? `(${notes.join('; ')})` : ''].filter(Boolean).join(' '), brands).slice(0, 300);
  }
  if (Array.isArray(p.enum)) out.enum = p.enum;
  if (type === 'array') {
    const items = (p.items && typeof p.items === 'object') ? projectProperty(p.items as Record<string, unknown>, brands) : {};
    out.items = items;
  }
  if (type === 'object' && p.properties && typeof p.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(p.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [k, projectProperty(v, brands)]),
    );
  }
  return out;
}

async function generate(entry: LocusParseProvider, doc: LocusProviderDoc, report: string[]): Promise<Generated[]> {
  const p = doc.provider;
  if (!p) throw new Error(`${entry.provider}: no provider document`);
  // The curated list only: a provider's display name can be a generic word
  // ("Web3") that belongs in a description.
  const brands = entry.brands;
  const out: Generated[] = [];
  const excluded = new Set(entry.exclude ?? []);
  for (const e of p.endpoints ?? []) {
    const endpoint = e.slug.includes('/') ? e.slug.slice(e.slug.indexOf('/') + 1) : e.slug;
    if (excluded.has(endpoint)) continue;
    if (e.enabled === false) {
      report.push(`DISABLED  ${e.slug} — left out; enable it on the Locus account and regenerate`);
      continue;
    }
    const price = Number(e.effectiveUsd ?? e.baseUsdc ?? NaN);
    if (!Number.isFinite(price)) {
      report.push(`NO PRICE  ${e.slug} — left out (${JSON.stringify(e.effectiveUsd)})`);
      continue;
    }
    // One-endpoint listings (`…/call`) carry the capability in the prefix.
    const suffix = endpoint === 'call' ? '' : `_${unbrand(snake(endpoint), brands)}`;
    let name = `${entry.prefix}${suffix}`;
    if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).replace(/_+$/, '');
    const rawDescription = [e.description, e.name].find((s) => typeof s === 'string' && s.trim()) ?? endpoint;
    const description = scrub(String(rawDescription), brands).slice(0, MAX_DESCRIPTION);
    assertNoBrand(description, brands, e.slug);
    assertNoBrand(name, brands, e.slug);
    const schema = e.inputSchema ?? {};
    const properties = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([k, v]) => [k, projectProperty(v as Record<string, unknown>, brands)]),
    );
    const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string' && r in properties) : [];
    // The endpoint's own schema source decides which of its value lists are
    // test inputs. Read from Parse's structured metadata, never from prose.
    const parseDoc = await fetchSchemaSource(e.schemaSource, report);
    const split = splitLocusSchemas(properties, required, testInputFieldsFor(parseDoc, endpoint));
    out.push({
      name,
      description,
      inputSchema: split.inputSchema,
      routingSchema: split.routingSchema,
      relaxed: split.relaxed,
      slug: e.slug,
      priceUsd: price,
      bucket: entry.bucket,
    });
  }
  return out;
}

function tsLiteral(v: unknown, indent: string): string {
  return JSON.stringify(v, null, 2).split('\n').map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

function renderTs(fns: Generated[], providers: string[]): string {
  const header = `// GENERATED by scripts/locus-catalog-sync.ts from the Locus account's catalog —
// do not edit; change src/catalog/locus-parse-allowlist.ts and regenerate.
//
// The resold public-data lane: every function is one enabled Locus endpoint
// (a provider's own API, or a Parse scraper of a public site), named for the
// capability and never for the vendor, with the provider's own argument
// names, Locus's listed price in USD (the figure booked only if Locus ever
// reports no charge), and the dispatch slug src/clients/locus.ts posts to.
// All read-only. Providers: ${providers.length}; functions: ${fns.length}.
//
// TWO SCHEMAS on a function whose source declares TEST INPUTS as if they were
// a domain. \`inputSchema\` is model-facing: the advisory enum is gone, its
// values are \`examples\`, and the property keeps its type. \`routingSchema\`
// is the strict schema Locus enforces and is never shown to a model — the
// backend checks a candidate's arguments against it and skips the call rather
// than spending a turn on a 400. Functions with a routingSchema: ${fns.filter((f) => f.routingSchema).length}.

import type { ConnectorFunction } from '../../types.js';
import type { LocusDispatchEntry } from './locus.js';

`;
  const schemaLiteral = (s: GeneratedSchema, indent: string): string => `{
${indent}  type: 'object',
${indent}  properties: ${tsLiteral(s.properties, `${indent}  `)},${s.required?.length ? `\n${indent}  required: ${JSON.stringify(s.required)},` : ''}
${indent}}`;
  const functions = fns.map((f) => `  {
    name: ${JSON.stringify(f.name)},
    description: ${JSON.stringify(f.description)},
    inputSchema: ${schemaLiteral(f.inputSchema, '    ')},${f.routingSchema ? `\n    routingSchema: ${schemaLiteral(f.routingSchema, '    ')},` : ''}
    categories: ['read'],
  },`).join('\n');
  const dispatch = fns.map((f) => `  ${JSON.stringify(f.name)}: { slug: ${JSON.stringify(f.slug)}, priceUsd: ${f.priceUsd} },`).join('\n');
  const buckets = fns.map((f) => `  ${JSON.stringify(f.name)}: ${JSON.stringify(f.bucket)},`).join('\n');
  return `${header}export const LOCUS_PARSE_FUNCTIONS: ConnectorFunction[] = [
${functions}
] as ConnectorFunction[];

export const LOCUS_PARSE_DISPATCH: Record<string, LocusDispatchEntry> = {
${dispatch}
};

/** The capability-tree bucket each function belongs to, for platform-backend. */
export const LOCUS_PARSE_BUCKETS: Record<string, string> = {
${buckets}
};
`;
}

function renderMigration(fns: Generated[], file: string): string {
  const rows = fns.map((f) => {
    const hash = createHash('sha256').update(f.description).digest('hex').slice(0, 12);
    return `  (${sql(f.name)}, 'locus', '${hash}', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)`;
  });
  return `-- ${path.basename(file)}: tool classification for the generated Locus Parse
-- functions (connector-service src/catalog/generated/locus-parse.ts, written
-- by scripts/locus-catalog-sync.ts from the Locus account's catalog). Each
-- reads public data through a resold endpoint and changes nothing in the
-- workspace's own systems: a reviewed, category-less classification, as
-- migrations 498, 502, 503 and 505 gave the rung's earlier functions. Hashes
-- are sha256 of each function's registry description, first twelve hex
-- characters, computed by the same generator that wrote the description; the
-- manual-override mark means a later description edit does not send the row
-- back to the classifier. Idempotent. ${fns.length} rows.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
${rows.join(',\n')}
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
`;
}

function sql(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const migrationFlag = args.indexOf('--pb-migration');
  const migrationPath = migrationFlag >= 0 ? args[migrationFlag + 1] : null;
  const catalogFlag = args.indexOf('--catalog');
  const catalogPath = catalogFlag >= 0 ? args[catalogFlag + 1] : null;

  // Offline: the documents were dumped by something that holds the key, and
  // this run only renders. Online: fetch them, which needs the key.
  const offline: Record<string, LocusProviderDoc> | null = catalogPath
    ? (JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Record<string, LocusProviderDoc>)
    : null;
  const key = offline ? '' : process.env.LOCUS_API_KEY;
  if (!offline && !key) {
    throw new Error('LOCUS_API_KEY is required (read it from Secret Manager; never commit it), or pass --catalog <file>');
  }
  const docOf = async (provider: string): Promise<LocusProviderDoc> => {
    if (!offline) return fetchProvider(provider, key as string);
    const doc = offline[provider];
    if (!doc) throw new Error(`${provider}: not in ${catalogPath} — the catalog file must cover every allowlist provider`);
    return doc;
  };

  const report: string[] = [];
  const all: Generated[] = [];
  const providers: string[] = [];
  for (const entry of LOCUS_PARSE_ALLOWLIST) {
    const doc = await docOf(entry.provider);
    const fns = await generate(entry, doc, report);
    report.push(`${entry.provider.padEnd(48)} ${String(fns.length).padStart(3)} functions  (${doc.provider?.name ?? '?'})`);
    all.push(...fns);
    providers.push(entry.provider);
  }
  const names = new Map<string, string>();
  for (const f of all) {
    const prev = names.get(f.name);
    if (prev) throw new Error(`name collision: ${f.name} from ${prev} and ${f.slug}`);
    names.set(f.name, f.slug);
  }
  fs.writeFileSync(OUT, renderTs(all, providers));
  report.push(`WROTE ${path.relative(process.cwd(), OUT)}: ${all.length} functions from ${providers.length} providers`);
  if (migrationPath) {
    fs.writeFileSync(migrationPath, renderMigration(all, migrationPath));
    report.push(`WROTE ${migrationPath}`);
  }
  const brands = [...new Set(LOCUS_PARSE_ALLOWLIST.flatMap((p) => p.brands))].sort();
  report.push(`BRANDS for platform-backend VENDOR_BRAND_TOKENS: ${JSON.stringify(brands)}`);
  // The classified set, from the generator rather than from an estimate: which
  // fields carried TEST INPUTS as if they were a domain, and therefore which
  // functions now carry a routingSchema.
  const relaxed = all.flatMap((f) => f.relaxed.map((field) => `${f.name}.${field}`));
  report.push(
    `TEST-INPUT ENUMS  ${relaxed.length} field(s) across ${all.filter((f) => f.routingSchema).length} function(s) `
    + `of ${all.length}; each keeps its type and its values as examples, and routes against the strict enum:`,
  );
  for (const field of relaxed) report.push(`  RELAXED  ${field}`);
  console.log(report.join('\n'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
