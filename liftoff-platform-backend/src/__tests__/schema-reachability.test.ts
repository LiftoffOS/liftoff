// No new table may ship that nothing queries.
//
// The schema-side twin of reachability.test.ts. That gate catches an export
// with no caller; this catches a table with no query, which is how
// `internal_agents.delegates` and `agent_quotas` both outlived the concepts
// they belonged to — one of them still validating its input on write, so it
// reads to an operator like a live grant.
//
// A ratchet, not a clean assertion, for the same reason as its sibling: the
// tree already carried this debt when the gate landed, and demanding it be
// resolved first would have meant not landing the gate.

import {
  findUnreferencedTables,
  findUnreferencedColumns,
  columnKey,
  liveTables,
} from './schema-reachability';
import {
  KNOWN_UNREFERENCED_TABLES,
  KNOWN_UNREFERENCED_COLUMNS,
} from './known-unreferenced-tables';

describe('every table is reachable from production code', () => {
  const found = findUnreferencedTables(process.cwd()).map((t) => t.table);
  const baseline = new Set(KNOWN_UNREFERENCED_TABLES);

  it('adds no new table that nothing queries', () => {
    const fresh = found.filter((t) => !baseline.has(t));
    if (fresh.length > 0) {
      throw new Error(
        `${fresh.length} table(s) exist in the schema with no production query:\n\n`
        + fresh.map((t) => `  ${t}`).join('\n')
        + '\n\nA table nothing reads is either unfinished wiring or the residue of a\n'
        + 'retired concept. When it carries permission- or capacity-shaped columns it\n'
        + 'is worse than dead weight: it reads like a control that is not enforced.\n\n'
        + 'Fix it one of these ways:\n'
        + '  1. Query it — wire the seam it was created for. Usually the answer.\n'
        + '  2. Drop it — in a migration, after counting the rows in production\n'
        + '     with a one-off SELECT.\n'
        + '  3. Add it to known-unreferenced-tables.ts WITH the reason, if another\n'
        + '     service owns it. A reviewer should ask which service and verify.\n',
      );
    }
  });

  it('does not let the debt list rot', () => {
    // A baseline entry that is now queried has been resolved. Leaving it listed
    // means the next genuinely dead table at that name ships unnoticed.
    const stale = [...baseline].filter((t) => !found.includes(t));
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} baseline entr(ies) are now referenced and should be removed from `
        + `known-unreferenced-tables.ts:\n\n${stale.map((t) => `  ${t}`).join('\n')}\n`,
      );
    }
  });
});

describe('every added column is reachable from production code', () => {
  const found = findUnreferencedColumns(process.cwd()).map(columnKey);
  const baseline = new Set(KNOWN_UNREFERENCED_COLUMNS);

  it('adds no new column that nothing reads', () => {
    const fresh = found.filter((k) => !baseline.has(k));
    if (fresh.length > 0) {
      throw new Error(
        `${fresh.length} column(s) were added to a live table with no production reader:\n\n`
        + fresh.map((k) => `  ${k}`).join('\n')
        + '\n\nA column is how a feature gets bolted onto an existing concept, so it is\n'
        + 'what gets orphaned when that concept is retired. When the column is\n'
        + 'permission- or capacity-shaped it is worse than dead weight: it reads like\n'
        + 'a control that nothing enforces.\n\n'
        + 'Fix it one of these ways:\n'
        + '  1. Read it — wire the seam it was added for. Usually the answer.\n'
        + '  2. Drop it — in a migration, after counting non-null rows in\n'
        + '     production with a one-off SELECT.\n'
        + '  3. Add it to known-unreferenced-tables.ts WITH the reason, if it is read\n'
        + '     somewhere this checker cannot see (another service, dynamic SQL).\n',
      );
    }
  });

  it('does not let the column debt list rot', () => {
    const stale = [...baseline].filter((k) => !found.includes(k));
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} column baseline entr(ies) are now read and should be removed from `
        + `known-unreferenced-tables.ts:\n\n${stale.map((k) => `  ${k}`).join('\n')}\n`,
      );
    }
  });
});

describe('the checker itself', () => {
  // These are the two classes that made a hand-written version report the
  // product's core tables as dead. They are asserted, not assumed.

  it('follows a rename instead of counting the old name', () => {
    const tables = liveTables(process.cwd());
    // ai_teams was renamed to internal_agents; only the new name is a table.
    expect(tables.has('internal_agents')).toBe(true);
    expect(tables.has('ai_teams')).toBe(false);
    expect(tables.has('ai_team_versions')).toBe(false);
    expect(tables.has('internal_agent_versions')).toBe(true);
  });

  it('does not treat partition children as tables', () => {
    const tables = liveTables(process.cwd());
    // cost_attribution_events is partitioned; the monthly children are reached
    // through the parent and never named in code.
    expect(tables.has('cost_attribution_events')).toBe(true);
    expect([...tables.keys()].some((t) => /^cost_attribution_events_y\d{4}m\d{2}$/.test(t)))
      .toBe(false);
  });

  it('ignores migration backup snapshots', () => {
    const tables = liveTables(process.cwd());
    expect([...tables.keys()].some((t) => /_(?:pre|backfill)_?\d+$/.test(t))).toBe(false);
  });

  it('drops a table that a later migration dropped', () => {
    const tables = liveTables(process.cwd());
    // engine_config's table-level twin: dropped in 265 once it read nowhere.
    expect(tables.has('cached_agent_quotas')).toBe(false);
  });

  it('does not report a column that a later migration dropped', () => {
    // engine_config was ADDed in 080 and DROPped in 265. It reads nowhere, so
    // a checker that ignored the drop would report it forever.
    const cols = findUnreferencedColumns(process.cwd()).map(columnKey);
    expect(cols).not.toContain('internal_agents::engine_config');
  });

  it('counts a snake_case column as read when only its camelCase form appears', () => {
    // Columns are usually reached through a row mapper, so `observation_count`
    // surfaces in code as `observationCount` and never as the SQL spelling.
    // Treating those as unreferenced would bury the real findings in noise.
    const cols = findUnreferencedColumns(process.cwd()).map(columnKey);
    expect(cols).not.toContain('agent_chat_threads::rolling_summary');
  });

  it('drops a column that a later migration dropped', () => {
    // internal_agents.delegates was ADDed in 080 and DROPped in 335. A checker
    // that ignored DROP COLUMN would report it forever, and the noise would
    // bury the real findings.
    const cols = findUnreferencedColumns(process.cwd()).map(columnKey);
    expect(cols).not.toContain('internal_agents::delegates');
  });
});
