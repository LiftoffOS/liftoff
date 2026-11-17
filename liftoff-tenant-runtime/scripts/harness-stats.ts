#!/usr/bin/env npx tsx
//
// Read our own telemetry.
//
// We emit `tool_catalog_size`, `tool_result_size_observed`, `prompt_tier_layout`
// and `context_pressure`. Nothing reads any of them. The cost of that is
// concrete and already recorded in the code: tool-result-bound.ts says its
// 50,000-character threshold came from "a one-off query that nothing in the
// system stores the inputs for" — a calibration nobody can reproduce, against a
// distribution nobody can re-measure.
//
// So every W4 change is supposed to cite this before and after, and `--since` is
// the point: "the catalog got smaller" is a claim, and this is what turns it
// into a number.
//
//   npx tsx scripts/harness-stats.ts --env dev --since 2026-08-01 \
//     --report catalog|tool-results|prompt-tiers|context-pressure
//
// Before and after in ONE command, which is the shape the citation actually
// needs — two invocations and a mental subtraction is how a "cite the numbers"
// rule quietly stops being followed:
//
//   npx tsx scripts/harness-stats.ts --env dev --report catalog \
//     --since 2026-08-09 --compare-since 2026-08-01 --compare-until 2026-08-08
//
// Reads Cloud Logging. Requires the gcloud CLI on PATH and credentials for the
// target project — the same access an operator already needs to read these logs
// by hand, so this adds no new grant. `--file <export.json>` reads a saved
// export instead, for a window already pulled or for a project you cannot reach.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

type Report = 'catalog' | 'tool-results' | 'prompt-tiers' | 'context-pressure';

const REPORTS: Report[] = ['catalog', 'tool-results', 'prompt-tiers', 'context-pressure'];

/** Which log event backs each report. */
const EVENT_FOR: Record<Report, string> = {
  catalog: 'tool_catalog_size',
  'tool-results': 'tool_result_size_observed',
  'prompt-tiers': 'prompt_tier_layout',
  'context-pressure': 'context_pressure',
};

interface Args {
  env: string;
  since: string;
  until?: string;
  report: Report;
  limit: number;
  /** Read from a JSON file instead of Cloud Logging. Two uses, both real: an
   *  operator comparing a window they exported earlier, and this script's own
   *  tests, which must be able to check the arithmetic without a project. */
  file?: string;
  /** The baseline export, when comparing two saved windows rather than two
   *  Cloud Logging queries. Without it a file-mode comparison would read the
   *  same file twice and report a delta of zero — a wrong answer that looks
   *  like a real one. */
  compareFile?: string;
  /** A second window to compare the first against. The whole reason `--since`
   *  is mandatory is that a change is supposed to cite a before and an after;
   *  making that two invocations and a mental subtraction is how it stops
   *  happening. */
  compareSince?: string;
  compareUntil?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const report = (get('--report') ?? 'catalog') as Report;
  if (!REPORTS.includes(report)) {
    throw new Error(`--report must be one of: ${REPORTS.join(', ')}`);
  }
  const since = get('--since');
  if (!since) {
    // Refused rather than defaulted. A window nobody chose produces a number
    // nobody can compare against, which is the situation this exists to end.
    throw new Error('--since is required (e.g. --since 2026-08-01). A before/after needs a stated window.');
  }
  const compareSince = get('--compare-since');
  const compareUntil = get('--compare-until');
  const compareFile = get('--compare-file');
  if (compareUntil && !compareSince) {
    throw new Error('--compare-until needs --compare-since: a window with only an end is not a window.');
  }
  const file = get('--file');
  if (file && compareSince && !compareFile) {
    // Refused rather than silently comparing a file against itself, which would
    // report a delta of zero — a wrong answer indistinguishable from "nothing
    // changed".
    throw new Error('--file with --compare-since needs --compare-file: name the baseline export to compare against.');
  }
  if (compareFile && !file) {
    throw new Error('--compare-file needs --file: comparing a saved export against a live query mixes two sources.');
  }
  return {
    env: get('--env') ?? 'dev',
    since,
    ...(get('--until') ? { until: get('--until') } : {}),
    report,
    limit: Number(get('--limit') ?? 5000),
    ...(file ? { file } : {}),
    ...(compareFile ? { compareFile } : {}),
    ...(compareSince ? { compareSince } : {}),
    ...(compareUntil ? { compareUntil } : {}),
  };
}

/** Cloud Logging entries for one window, or a file when one was given. */
function fetchEntries(
  args: Args,
  window: { since: string; until?: string; file?: string } =
    { since: args.since, ...(args.until ? { until: args.until } : {}), ...(args.file ? { file: args.file } : {}) },
): Array<Record<string, unknown>> {
  if (window.file) {
    const raw = readFileSync(window.file, 'utf8');
    return normalizeEntries(JSON.parse(raw), EVENT_FOR[args.report]);
  }
  const project = `YOUR_GCP_PROJECT${args.env}`;
  const filter = [
    'resource.type="cloud_run_revision"',
    `jsonPayload.event="${EVENT_FOR[args.report]}"`,
    `timestamp>="${window.since}T00:00:00Z"`,
    ...(window.until ? [`timestamp<"${window.until}T00:00:00Z"`] : []),
  ].join(' AND ');

  const raw = execFileSync('gcloud', [
    'logging', 'read', filter,
    `--project=${project}`,
    `--limit=${args.limit}`,
    '--format=json',
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  return normalizeEntries(JSON.parse(raw), EVENT_FOR[args.report]);
}

/** Accept both shapes a caller can produce: raw Cloud Logging entries
 *  (`{ jsonPayload }`) and an already-unwrapped array of payloads, which is what
 *  an operator gets from `jq '.[].jsonPayload'`. Filtering by event here rather
 *  than trusting the caller means a file exported for one report cannot be
 *  silently misread as another. */
function normalizeEntries(parsed: unknown, event: string): Array<Record<string, unknown>> {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((e) => {
      const rec = e as { jsonPayload?: Record<string, unknown> };
      return rec?.jsonPayload ?? (e as Record<string, unknown>);
    })
    .filter((p) => p && typeof p === 'object' && Object.keys(p).length > 0)
    .filter((p) => p.event === undefined || p.event === event);
}

/** p50 / p95 / max over a numeric series. Reported together because a mean
 *  hides exactly the tail these budgets exist to bound — the tool-result
 *  distribution that motivated all of this was p50=350 and p99=33,275. */
function quantiles(values: number[]): { n: number; p50: number; p95: number; max: number } {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function table(rows: Array<Record<string, string | number>>): void {
  if (rows.length === 0) {
    // Said plainly. "No rows" and "the query was wrong" look identical
    // otherwise, and a silent empty report is how a dead signal stays dead.
    process.stdout.write('  (no entries in this window)\n');
    return;
  }
  const cols = Object.keys(rows[0]);
  const width = Object.fromEntries(cols.map((c) => [
    c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  ]));
  const line = (cells: Array<string | number>) =>
    cells.map((cell, i) => String(cell).padEnd(width[cols[i]])).join('  ');
  process.stdout.write(`  ${line(cols)}\n`);
  process.stdout.write(`  ${cols.map((c) => '-'.repeat(width[c])).join('  ')}\n`);
  for (const r of rows) process.stdout.write(`  ${line(cols.map((c) => r[c] ?? ''))}\n`);
}

// ── catalog — tool count and schema chars by source, per agent ──────────────
function reportCatalog(entries: Array<Record<string, unknown>>): void {
  const counts = entries.map((e) => num(e.toolCount)).filter((n): n is number => n !== null);
  const chars = entries.map((e) => num(e.schemaChars)).filter((n): n is number => n !== null);
  process.stdout.write('\nTool catalog size\n');
  table([
    { metric: 'toolCount', ...quantiles(counts) },
    { metric: 'schemaChars', ...quantiles(chars) },
  ]);

  // By source, because the W4 argument is about WHICH tools: the sandbox
  // family and one oversized vendor server are the two that matter, and an
  // aggregate hides both.
  const sources = new Map<string, { count: number; chars: number; runs: number }>();
  for (const e of entries) {
    const bySource = e.bySource as Record<string, unknown> | undefined;
    const charsBySource = e.charsBySource as Record<string, unknown> | undefined;
    if (!bySource) continue;
    for (const [source, v] of Object.entries(bySource)) {
      const acc = sources.get(source) ?? { count: 0, chars: 0, runs: 0 };
      acc.count += num(v) ?? 0;
      acc.chars += num(charsBySource?.[source]) ?? 0;
      acc.runs += 1;
      sources.set(source, acc);
    }
  }
  process.stdout.write('\nBy source (mean per run)\n');
  table([...sources.entries()]
    .sort((a, b) => b[1].chars - a[1].chars)
    .map(([source, v]) => ({
      source,
      meanTools: (v.count / Math.max(v.runs, 1)).toFixed(1),
      meanChars: Math.round(v.chars / Math.max(v.runs, 1)),
      runs: v.runs,
    })));

  const perAgent = new Map<string, number[]>();
  for (const e of entries) {
    const agentId = String(e.agentId ?? 'unknown');
    const c = num(e.schemaChars);
    if (c === null) continue;
    perAgent.set(agentId, [...(perAgent.get(agentId) ?? []), c]);
  }
  process.stdout.write('\nWorst agents by schema chars (p95)\n');
  table([...perAgent.entries()]
    .map(([agentId, v]) => ({ agentId, ...quantiles(v) }))
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 10));
}

// ── tool-results — size distribution vs the configured bound ────────────────
function reportToolResults(entries: Array<Record<string, unknown>>): void {
  const chars = entries.map((e) => num(e.chars)).filter((n): n is number => n !== null);
  const exceeded = entries.filter((e) => e.exceeded === true).length;
  const budgets = new Set(entries.map((e) => num(e.budget)).filter((n) => n !== null));
  process.stdout.write('\nTool-result sizes\n');
  table([{ metric: 'chars', ...quantiles(chars) }]);
  process.stdout.write('\nAgainst the bound\n');
  table([{
    budget: [...budgets].join(', ') || 'unknown',
    observations: entries.length,
    overBudget: exceeded,
    percentOver: entries.length ? `${((exceeded / entries.length) * 100).toFixed(1)}%` : '0%',
  }]);
}

// ── prompt-tiers — stable/session/volatile shares over time ─────────────────
function reportPromptTiers(entries: Array<Record<string, unknown>>): void {
  const stable = entries.map((e) => num(e.stableChars) ?? 0);
  const session = entries.map((e) => num(e.sessionChars) ?? 0);
  const volatile = entries.map((e) => num(e.volatileChars) ?? 0);
  const prefix = entries.map((e) => num(e.cacheablePrefixChars)).filter((n): n is number => n !== null);

  const total = stable.reduce((a, b) => a + b, 0)
    + session.reduce((a, b) => a + b, 0)
    + volatile.reduce((a, b) => a + b, 0);
  const share = (xs: number[]) => (total ? `${((xs.reduce((a, b) => a + b, 0) / total) * 100).toFixed(1)}%` : '0%');

  process.stdout.write('\nPrompt tier shares\n');
  table([
    { tier: 'stable', share: share(stable), ...quantiles(stable) },
    { tier: 'session', share: share(session), ...quantiles(session) },
    { tier: 'volatile', share: share(volatile), ...quantiles(volatile) },
  ]);
  // The stable share collapsing is what a change that pushed volatile content
  // above the breakpoint looks like.
  process.stdout.write('\nCacheable prefix\n');
  table([{ metric: 'cacheablePrefixChars', ...quantiles(prefix) }]);
}

// ── context-pressure — usedRatio distribution by engine ─────────────────────
function reportContextPressure(entries: Array<Record<string, unknown>>): void {
  const samples = entries.filter((e) => num(e.usedRatio) !== null);
  if (samples.length === 0) {
    process.stdout.write('\nNo in-run context samples in this window.\n');
    return;
  }
  const byProvider = new Map<string, number[]>();
  for (const e of samples) {
    const key = `${String(e.provider ?? 'unknown')}/${String(e.model ?? 'unknown')}`;
    byProvider.set(key, [...(byProvider.get(key) ?? []), num(e.usedRatio) as number]);
  }
  process.stdout.write('\nContext used-ratio by provider/model\n');
  table([...byProvider.entries()]
    .map(([k, v]) => {
      const q = quantiles(v);
      return { engine: k, n: q.n, p50: q.p50.toFixed(3), p95: q.p95.toFixed(3), max: q.max.toFixed(3) };
    })
    .sort((a, b) => Number(b.p95) - Number(a.p95)));

  // The provenance split matters more than the ratio: only a registry-backed
  // window may drive a retirement, so a fleet reading mostly provider floors is
  // one where the ratios are indicative and nothing can act on them.
  const bySource = new Map<string, number>();
  for (const e of samples) {
    const src = String(e.contextWindowSource ?? 'unrecorded');
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
  }
  process.stdout.write('\nWindow provenance (only `registry` may drive a retirement)\n');
  table([...bySource.entries()].map(([source, n]) => ({
    source, samples: n, percent: `${((n / samples.length) * 100).toFixed(1)}%`,
  })));

  const managed = samples.filter((e) => e.managesOwnContext === true).length;
  process.stdout.write('\nMeasurement coverage\n');
  table([{
    totalSamples: samples.length,
    // These are the engines that were invisible before: measurement used to be
    // gated on the same flag that gates the nudge.
    sdkManagedEngines: managed,
    platformManaged: samples.length - managed,
  }]);
}

/** The headline number for each report — the one a change is expected to cite.
 *
 *  One number per report rather than a diff of every table: a comparison that
 *  prints forty deltas is one nobody reads, and the argument a W4 change has to
 *  make is about a single quantity moving. */
const HEADLINE: Record<Report, { label: string; of: (e: Array<Record<string, unknown>>) => number }> = {
  catalog: {
    label: 'schemaChars p50',
    of: (e) => quantiles(e.map((x) => num(x.schemaChars)).filter((n): n is number => n !== null)).p50,
  },
  'tool-results': {
    label: 'result chars p95',
    of: (e) => quantiles(e.map((x) => num(x.chars)).filter((n): n is number => n !== null)).p95,
  },
  'prompt-tiers': {
    label: 'cacheable prefix p50',
    of: (e) => quantiles(e.map((x) => num(x.cacheablePrefixChars)).filter((n): n is number => n !== null)).p50,
  },
  'context-pressure': {
    label: 'used-ratio p95',
    of: (e) => quantiles(e.map((x) => num(x.usedRatio)).filter((n): n is number => n !== null)).p95,
  },
};

function runReport(report: Report, entries: Array<Record<string, unknown>>): void {
  switch (report) {
    case 'catalog': return reportCatalog(entries);
    case 'tool-results': return reportToolResults(entries);
    case 'prompt-tiers': return reportPromptTiers(entries);
    case 'context-pressure': return reportContextPressure(entries);
  }
}

/** Before → after, as a signed delta and a percentage.
 *
 *  Exported and pure so the arithmetic is testable: a comparison that reports
 *  the wrong direction is worse than no comparison, because it will be quoted. */
export function compare(
  before: number,
  after: number,
): { before: number; after: number; delta: number; percent: string; direction: 'down' | 'up' | 'flat' } {
  const delta = after - before;
  // A percentage against a zero baseline is not a percentage. Said, rather than
  // printed as Infinity or NaN and left for the reader to interpret.
  const percent = before === 0 ? 'n/a (no baseline)' : `${((delta / before) * 100).toFixed(1)}%`;
  return {
    before, after, delta, percent,
    direction: delta < 0 ? 'down' : delta > 0 ? 'up' : 'flat',
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const source = args.file ? `file=${args.file}` : `env=${args.env}`;
  process.stdout.write(`harness-stats · ${args.report} · ${source} · since=${args.since}`);
  process.stdout.write(args.until ? ` until=${args.until}\n` : '\n');

  const entries = fetchEntries(args);
  process.stdout.write(`${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'} read\n`);
  runReport(args.report, entries);

  if (!args.compareSince && !args.compareFile) return;

  // The comparison window. Named BEFORE/AFTER in the output rather than left as
  // two windows the reader has to order themselves.
  const baselineLabel = args.compareFile
    ? `file=${args.compareFile}`
    : `since=${args.compareSince}${args.compareUntil ? ` until=${args.compareUntil}` : ''}`;
  process.stdout.write(`\n── BEFORE · ${baselineLabel} ──\n`);
  const baseline = fetchEntries(args, {
    since: args.compareSince ?? args.since,
    ...(args.compareUntil ? { until: args.compareUntil } : {}),
    ...(args.compareFile ? { file: args.compareFile } : {}),
  });
  process.stdout.write(`${baseline.length} log entr${baseline.length === 1 ? 'y' : 'ies'} read\n`);
  runReport(args.report, baseline);

  const h = HEADLINE[args.report];
  const c = compare(h.of(baseline), h.of(entries));
  process.stdout.write(`\n${h.label}\n`);
  table([{
    before: c.before,
    after: c.after,
    delta: c.delta,
    percent: c.percent,
    direction: c.direction,
  }]);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`harness-stats failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// Exported for the unit tests: the aggregation is the part worth asserting, and
// it should not need Cloud Logging to be reachable to be checked.
export {
  parseArgs, quantiles, reportCatalog, reportToolResults,
  reportPromptTiers, reportContextPressure, normalizeEntries,
  HEADLINE, EVENT_FOR, REPORTS,
};
