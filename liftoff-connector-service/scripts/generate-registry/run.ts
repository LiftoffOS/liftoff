// Registry generation — runner.
//
//   npm run gen:registry -- --vendor tikhub --spec /path/to/openapi.json
//   npm run gen:registry -- --vendor strale --spec /path/to/openapi.json --llm
//
// Reads a vendor's machine-readable API description, applies that vendor's
// curation config (the ONLY place inclusion policy lives), normalizes
// deterministically, merges overrides, and emits
// src/catalog/generated/<vendor>.ts as COMMITTED, review-able source. The
// emitted file is never edited by hand; regeneration + a PR diff is the
// maintenance loop, run manually — there is no scheduled catalog touching.

import * as fs from 'fs';
import * as path from 'path';
import { extractOperations, type OpenApiOperation } from './openapi-adapter';
import { normalizeOperation, snakeCase, type GeneratedFunction } from './normalize';
import { refineWithModel } from './llm-stage';
import { OVERRIDES } from './overrides';

interface VendorConfig {
  vendor: string;
  sourceUrl: string;
  include: (op: OpenApiOperation) => boolean;
  normalizeOpts: (op: OpenApiOperation) => Parameters<typeof normalizeOperation>[1];
  /** Replace method-derived categories wholesale. For a vendor whose whole
   *  surface is metered computation (Strale: checks, lookups, validation,
   *  redaction), HTTP method says nothing about side effects — nothing there
   *  mutates an external system, so every capability is 'read'. */
  forceCategories?: ('read' | 'write' | 'destructive' | 'outbound' | 'sensitive')[];
}

/** TikHub platform segment: /api/v1/<platform>/... */
const tikhubPlatform = (p: string): string => p.split('/')[3] ?? '';

/** TikHub head operations — the public-data reads worth exposing, across every
 *  platform. Keeps the callable surface to the demand head (~180) instead of
 *  the full 1,044-endpoint long tail. */
const TIKHUB_HEAD_OP =
  /(user_info|user_profile|handler_user_profile|user_post|user_video|user_feed|post_detail|video_detail|aweme_detail|post_comment|video_comment|fetch_comment|general_search|search_user|search_video|fetch_search|user_follower|user_following|user_fans|profile_videos)/;

/** Long-tail families excluded even when a head keyword matches: ads,
 *  analytics, commerce, live, music, and the niche CN aggregators. */
const TIKHUB_LONGTAIL =
  /(\/ads\/|\/analytics\/|\/xingtu|billboard|\/shop|\/music|\/live\/|creator_search_insights|\/xigua|\/pipixia|\/toutiao)/;

/** Strale capability slugs that belong to the DEFERRED crypto slice. The
 *  ruling defers crypto capabilities platform-wide; a vendor's spec does not
 *  get to reintroduce them through the side door. */
const STRALE_CRYPTO_PATTERN =
  /(bitcoin|btc|ethereum|eth-|solana|tron|xrp|doge|wallet|token|defi|web3|onchain|on-chain|nft|crypto|approval-security|x402-)/;

const VENDORS: Record<string, VendorConfig> = {
  tikhub: {
    vendor: 'tikhub',
    sourceUrl: 'https://api.tikhub.io/openapi.json',
    // ALL real platforms ship (no CN cut), but curated to
    // the HEAD OPERATIONS only — the public-data reads people actually want
    // (user profile/info, user posts/videos, post/video detail, comments,
    // search, followers). The full surface is 1,044 endpoints, a long tail of
    // ads/analytics/shop/live niches that floods the distill catalog and
    // bloats every projection; the head is ~180. Excluded: TikHub's own
    // account/meta surface, demo/health, and the long-tail families.
    include: (op) => {
      const platform = tikhubPlatform(op.path);
      if (
        !op.path.startsWith('/api/v1/') ||
        platform.length === 0 ||
        platform === 'tikhub' ||
        platform === 'demo' ||
        platform === 'health'
      ) {
        return false;
      }
      if (TIKHUB_LONGTAIL.test(op.path)) return false;
      return TIKHUB_HEAD_OP.test(op.path);
    },
    normalizeOpts: (op) => ({
      namePrefix: snakeCase(tikhubPlatform(op.path)),
      // FastAPI operationIds echo the full path; name from the path segments
      // after api/v1/<platform> instead. Family/version segments (web, app,
      // v2, v3) stay in the name — the same operation exists across families
      // and they are what disambiguates.
      ignoreOperationId: true,
      dropLeadingSegments: 3,
    }),
    // TikHub retrieves social-platform data and mutates nothing anywhere; its
    // POST endpoints are batch-shaped reads (a query body, not a side effect).
    forceCategories: ['read'],
  },
  strale: {
    vendor: 'strale',
    sourceUrl: 'https://api.strale.io/openapi.json',
    // Per-capability surface only (/x402/v2/<slug> carries each capability's
    // input schema and price). Execution goes through the wallet lane
    // (POST /v1/do with capability_slug) — the dispatcher owns that mapping;
    // the function name IS the slug. Crypto slugs are deferred (see pattern).
    include: (op) =>
      op.path.startsWith('/x402/v2/') && !STRALE_CRYPTO_PATTERN.test(op.path),
    normalizeOpts: () => ({ nameFromPathSegments: 1, includePrice: true }),
    forceCategories: ['read'],
  },
};

export interface DispatchEntry {
  method: string;
  path: string;
  priceUsd?: number;
}

function emit(
  vendor: string,
  sourceUrl: string,
  functions: GeneratedFunction[],
  dispatch: Record<string, DispatchEntry>,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = functions.map(
    (f) => `  ${JSON.stringify(f)},`,
  );
  const dispatchLines = Object.entries(dispatch).map(
    ([name, d]) => `  ${JSON.stringify(name)}: ${JSON.stringify(d)},`,
  );
  return `// GENERATED FILE — DO NOT EDIT BY HAND.
// Vendor: ${vendor}
// Source: ${sourceUrl} (fetched ${today})
// Generator: scripts/generate-registry/run.ts
// Functions: ${functions.length}
// Hand-fixes belong in scripts/generate-registry/overrides.ts and land on the
// next regeneration; edits here are overwritten.

import type { ConnectorFunction } from '../../types.js';

export const ${vendor.toUpperCase()}_FUNCTIONS: ConnectorFunction[] = [
${lines.join('\n')}
];

/** Function name -> the vendor's own REST operation, for the native executor
 *  in src/clients/${vendor}.ts. Co-generated with the functions above so the
 *  two can never drift apart. priceUsd is the vendor's declared per-call
 *  price where the spec carries one. */
export const ${vendor.toUpperCase()}_DISPATCH: Record<string, { method: string; path: string; priceUsd?: number }> = {
${dispatchLines.join('\n')}
};
`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const vendorArg = args[args.indexOf('--vendor') + 1];
  const specArg = args[args.indexOf('--spec') + 1];
  const useLlm = args.includes('--llm');
  const config = VENDORS[vendorArg];
  if (!config || !specArg) {
    console.error('usage: run.ts --vendor <tikhub|strale> --spec <openapi.json> [--llm]');
    process.exit(1);
  }

  const doc = JSON.parse(fs.readFileSync(specArg, 'utf8'));
  const ops = extractOperations(doc).filter(config.include);

  const seen = new Set<string>();
  const functions: GeneratedFunction[] = [];
  const dispatch: Record<string, DispatchEntry> = {};
  for (const op of ops) {
    const fn = normalizeOperation(op, config.normalizeOpts(op));
    if (config.forceCategories) fn.categories = [...config.forceCategories];
    if (seen.has(fn.name)) continue; // first wins; duplicates are spec noise
    seen.add(fn.name);
    const override = OVERRIDES[config.vendor]?.[fn.name];
    functions.push(override ? { ...fn, ...override } : fn);
    dispatch[fn.name] = {
      method: op.method,
      path: op.path,
      ...(typeof op.priceUsd === 'number' ? { priceUsd: op.priceUsd } : {}),
    };
  }
  functions.sort((a, b) => a.name.localeCompare(b.name));
  const sortedDispatch: Record<string, DispatchEntry> = {};
  for (const f of functions) sortedDispatch[f.name] = dispatch[f.name];

  let finalFunctions = functions;
  if (useLlm) {
    const { refined, refinedCount } = await refineWithModel(functions);
    finalFunctions = refined;
    console.log(`llm-stage: ${refinedCount}/${functions.length} descriptions refined`);
  }

  const outPath = path.join(
    __dirname, '..', '..', 'src', 'catalog', 'generated', `${config.vendor}.ts`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, emit(config.vendor, config.sourceUrl, finalFunctions, sortedDispatch));
  // Reported from what was WRITTEN, not from a loop tally.
  const written = (fs.readFileSync(outPath, 'utf8').match(/^  \{/gm) ?? []).length;
  console.log(`${config.vendor}: ${written} functions -> ${outPath}`);
}

void main();
