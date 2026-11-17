#!/usr/bin/env npx ts-node
/**
 * Validation gate: every vendor slug in src/schemas/*.ts MUST exist in the
 * live Composio tool list for its toolkit. It guards against fabricated
 * slugs: a seed schema hand-authored with a GUESSED slug (e.g.
 * GONG_LIST_CALLS) that does not exist in Composio (real:
 * GONG_ADD_NEW_CALL_V2_CALLS) makes every dispatch 404 with
 * ComposioToolNotFoundError.
 *
 * Curation (exposing a SUBSET of a toolkit's tools) is allowed — the gate
 * only asserts subset ⊆ real. Fabrication (a slug not in Composio) fails.
 *
 * Usage:  npm run validate:slugs
 * Env:    COMPOSIO_API_KEY  (dev or prod key — the toolkit tool lists are
 *         identical across orgs; any valid key works).
 * Exit:   0 = all slugs real; 1 = one or more fabricated (lists them).
 *
 * Wire this into CI (platform-backend .github/workflows/ci.yml) as a step
 * with COMPOSIO_API_KEY from Secret Manager, BEFORE publishing the package.
 */

import { COMPOSIO_TOOL_SCHEMAS } from '../src/schemas';
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


async function fetchToolIndex<T extends { slug: string }>(
  apiKey: string,
  toolkit: string,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();

  // 1. SDK — the current published catalog.
  try {
    const composio = new Composio({ apiKey });
    const tools = (await (composio.tools as unknown as {
      getRawComposioTools: (o: { toolkits: string[]; limit: number }) => Promise<T[]>;
    }).getRawComposioTools({ toolkits: [toolkit], limit: 500 })) ?? [];
    for (const t of tools) out.set(t.slug, t);
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

async function fetchRealSlugs(apiKey: string, toolkit: string): Promise<Set<string>> {
  return new Set((await fetchToolIndex<{ slug: string }>(apiKey, toolkit)).keys());
}

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    console.error('COMPOSIO_API_KEY is required (dev or prod Composio key).');
    process.exit(2);
  }

  const violations: { toolkit: string; slug: string }[] = [];
  const emptyToolkits: string[] = [];

  for (const [toolkit, schemas] of Object.entries(COMPOSIO_TOOL_SCHEMAS)) {
    let real: Set<string>;
    try {
      real = await fetchRealSlugs(apiKey, toolkit);
    } catch (e) {
      console.error(`  ${toolkit}: ERROR fetching real slugs — ${(e as Error).message}`);
      violations.push({ toolkit, slug: '<toolkit-fetch-failed>' });
      continue;
    }
    if (real.size === 0) emptyToolkits.push(toolkit);
    const bad = schemas.map((s) => s.slug).filter((slug) => !real.has(slug));
    for (const slug of bad) violations.push({ toolkit, slug });
    const total = schemas.length;
    const status = bad.length === 0 ? 'ok' : `${bad.length}/${total} FABRICATED`;
    console.error(`  ${toolkit.padEnd(20)} ${status}`);
  }

  if (emptyToolkits.length) {
    console.error(`\nWARNING: Composio returned 0 tools for: ${emptyToolkits.join(', ')} ` +
      `(wrong toolkit slug key? these will never surface real tools).`);
  }

  if (violations.length) {
    console.error(`\nFAIL: ${violations.length} fabricated slug(s) — not present in Composio:`);
    for (const v of violations) console.error(`  - ${v.toolkit}.${v.slug}`);
    console.error(`\nFix: regenerate the schema from Composio (npm run sync:schemas) and ` +
      `re-map the overlay's vendorToolName to a REAL slug. Never hand-author slugs.`);
    process.exit(1);
  }

  console.error(`\nOK: all schema slugs across ${Object.keys(COMPOSIO_TOOL_SCHEMAS).length} toolkits are real.`);
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
