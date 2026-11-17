/**
 * Schema Validation Test for Scheduled Invoke Path
 *
 * This test traces EVERY SQL query in the scheduled-invoke execution path
 * and validates that all referenced columns exist in the migration-defined schema.
 *
 * It does NOT require a running database - it parses SQL from the codebase
 * and cross-references against migration files.
 */

import * as fs from 'fs';
import * as path from 'path';

// Parse all migration files to build a schema map
/** Parse a migrations directory into table → columns.
 *
 *  Takes the directory so the parser can be exercised on a fixture rather than
 *  only on the real tree. A parser that can only be run against production
 *  migrations cannot be shown to have a blind spot — which is how it kept one. */
function buildSchemaFromMigrations(migrationsDirOverride?: string): Map<string, Set<string>> {
  const migrationsDir = migrationsDirOverride ?? path.join(__dirname, '../../../migrations');
  const schema = new Map<string, Set<string>>();

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    // Parse CREATE TABLE statements
    const createTableRegex = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\);/gi;
    let match;
    while ((match = createTableRegex.exec(sql)) !== null) {
      const tableName = match[1];
      const body = match[2];
      if (!schema.has(tableName)) {
        schema.set(tableName, new Set());
      }
      const cols = schema.get(tableName)!;

      // Extract column names (first word of each line that isn't a constraint)
      const lines = body.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('CONSTRAINT') ||
            trimmed.startsWith('PRIMARY') || trimmed.startsWith('UNIQUE') ||
            trimmed.startsWith('CHECK') || trimmed.startsWith('FOREIGN') ||
            trimmed.startsWith('CREATE') || trimmed.startsWith(')')
        ) continue;
        const colMatch = trimmed.match(/^(\w+)\s/);
        if (colMatch && !['ON', 'REFERENCES', 'DEFAULT', 'NOT', 'NULL', 'SET', 'WHERE', 'AND', 'OR', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'BEGIN', 'COMMIT', 'ROLLBACK', 'ALTER', 'DROP', 'ADD', 'IF', 'GRANT', 'INDEX'].includes(colMatch[1].toUpperCase())) {
          cols.add(colMatch[1].toLowerCase());
        }
      }
    }

    // Handle table renames (e.g., instructions -> compiled_instructions)
    const renameRegex = /ALTER TABLE (?:IF EXISTS )?(\w+)\s+RENAME TO (\w+)/gi;
    while ((match = renameRegex.exec(sql)) !== null) {
      const oldName = match[1];
      const newName = match[2];
      if (schema.has(oldName)) {
        schema.set(newName, schema.get(oldName)!);
      }
    }

    // Parse ALTER TABLE ADD COLUMN statements, INCLUDING the multi-column form.
    //
    // `ALTER TABLE t ADD COLUMN a …, ADD COLUMN b …, ADD COLUMN c …;` is one
    // statement with three columns. Matching only `ALTER TABLE (\w+)\s+ADD
    // COLUMN (\w+)` captured the FIRST and silently dropped the rest — so a
    // query naming `b` or `c` went unchecked by the very gate that exists to
    // catch a column the code reads and the migrations never created. The
    // failure was invisible in both directions: no error, just fewer columns
    // known than the schema actually has.
    //
    // Two steps now: find each ALTER TABLE statement up to its terminating
    // semicolon, then take every ADD COLUMN clause inside it.
    const alterStatementRegex = /ALTER TABLE (?:IF EXISTS )?(\w+)([\s\S]*?);/gi;
    while ((match = alterStatementRegex.exec(sql)) !== null) {
      const tableName = match[1];
      const body = match[2];
      const addColumnRegex = /ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi;
      let colMatch;
      let sawColumn = false;
      while ((colMatch = addColumnRegex.exec(body)) !== null) {
        if (!schema.has(tableName)) schema.set(tableName, new Set());
        schema.get(tableName)!.add(colMatch[1].toLowerCase());
        sawColumn = true;
      }
      // An ALTER that adds no column (a constraint, a rename, a type change) is
      // not a schema-knowledge gain and must not create an empty table entry —
      // an empty entry would make every column of that table read as missing.
      if (!sawColumn) continue;
    }
  }

  return schema;
}

// Extract SQL queries from TypeScript source files
function extractQueriesFromFile(filePath: string): Array<{ query: string; line: number }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const queries: Array<{ query: string; line: number }> = [];

  // Match pool.query(`...`) or query(`...`) patterns
  const queryRegex = /\.query\(\s*[`']([^`']+)[`']/g;
  let match;
  while ((match = queryRegex.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    queries.push({ query: match[1], line: lineNum });
  }

  // Also match multi-line template literals
  const templateRegex = /\.query\(\s*`([\s\S]*?)`/g;
  while ((match = templateRegex.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    queries.push({ query: match[1], line: lineNum });
  }

  return queries;
}

// Parse table aliases from a SQL query (FROM and JOIN clauses).
// Returns a map of alias -> real table name. The "default" key holds the
// FROM table, used for unqualified column references.
function parseTableAliases(sql: string): { aliases: Map<string, string>; defaultTable: string | null } {
  const aliases = new Map<string, string>();
  let defaultTable: string | null = null;

  // FROM table [AS] alias
  const fromMatch = sql.match(/\bFROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/i);
  if (fromMatch) {
    const table = fromMatch[1].toLowerCase();
    defaultTable = table;
    aliases.set(table, table); // Self-reference
    if (fromMatch[2] && !['where', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'order', 'limit'].includes(fromMatch[2].toLowerCase())) {
      aliases.set(fromMatch[2].toLowerCase(), table);
    }
  }

  // JOIN table [AS] alias
  const joinRegex = /\b(?:LEFT|RIGHT|INNER|OUTER|CROSS)?\s*JOIN\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
  let joinMatch;
  while ((joinMatch = joinRegex.exec(sql)) !== null) {
    const table = joinMatch[1].toLowerCase();
    aliases.set(table, table);
    if (joinMatch[2] && !['on', 'where', 'group', 'order', 'limit'].includes(joinMatch[2].toLowerCase())) {
      aliases.set(joinMatch[2].toLowerCase(), table);
    }
  }

  return { aliases, defaultTable };
}

// Parse column references from a SQL query.
// Properly handles JOINs and table aliases: a column qualified as `alias.column`
// is attributed to the real table that `alias` refers to, not to the FROM table.
function parseColumnsFromQuery(sql: string): Array<{ table: string; columns: string[] }> {
  const tableColumns = new Map<string, Set<string>>();
  const addCol = (table: string, col: string) => {
    if (!tableColumns.has(table)) tableColumns.set(table, new Set());
    tableColumns.get(table)!.add(col);
  };

  const normalized = sql.replace(/\s+/g, ' ').trim();
  const { aliases, defaultTable } = parseTableAliases(normalized);

  // SELECT ... FROM
  const selectMatch = normalized.match(/SELECT\s+([\s\S]+?)\s+FROM\s+/i);
  if (selectMatch && defaultTable) {
    const colsPart = selectMatch[1];
    if (colsPart.trim() !== '*') {
      // Split by commas not inside parentheses
      const parts = colsPart.split(/,(?![^(]*\))/).map(c => c.trim());
      for (const part of parts) {
        // Strip "AS alias" suffixes
        const stripped = part.replace(/\s+as\s+\w+\s*$/i, '').trim();
        // Qualified: alias.column
        const qualified = stripped.match(/^(\w+)\.(\w+)$/);
        if (qualified) {
          const aliasName = qualified[1].toLowerCase();
          const col = qualified[2].toLowerCase();
          const realTable = aliases.get(aliasName) || defaultTable;
          addCol(realTable, col);
          continue;
        }
        // Unqualified: simple identifier
        const simple = stripped.match(/^(\w+)$/);
        if (simple) {
          addCol(defaultTable, simple[1].toLowerCase());
        }
        // Otherwise (functions, expressions), skip
      }
    }
  }

  // INSERT INTO table (col1, col2, ...)
  const insertMatch = normalized.match(/INSERT INTO\s+(\w+)\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const table = insertMatch[1].toLowerCase();
    const cols = insertMatch[2].split(',').map(c => c.trim().toLowerCase());
    for (const col of cols) addCol(table, col);
  }

  // UPDATE table SET col1 = ...
  const updateMatch = normalized.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)\s+WHERE/i);
  if (updateMatch) {
    const table = updateMatch[1].toLowerCase();
    const setPart = updateMatch[2];
    const cols = setPart.split(',')
      .map(c => c.trim().split('=')[0].trim().toLowerCase())
      .filter(c => c && !c.includes('('));
    for (const col of cols) addCol(table, col);
  }

  // WHERE clauses — column references (qualified or unqualified)
  const whereMatch = normalized.match(/WHERE\s+([\s\S]+?)(?:ORDER|GROUP|LIMIT|$)/i);
  if (whereMatch && defaultTable) {
    const wherePart = whereMatch[1];
    // Match qualified refs: alias.column
    const qualifiedRefs = wherePart.match(/\b(\w+)\.(\w+)\b/g) || [];
    for (const ref of qualifiedRefs) {
      const [aliasName, col] = ref.toLowerCase().split('.');
      const realTable = aliases.get(aliasName) || defaultTable;
      addCol(realTable, col);
    }
    // Match unqualified refs: column = / column IS / etc.
    const unqualifiedRefs = wherePart.match(/\b(\w+)\s*(?:=|IS|IN|>|<|LIKE|ILIKE|!=|<>)/gi) || [];
    for (const ref of unqualifiedRefs) {
      const col = ref.replace(/\s*(=|IS|IN|>|<|LIKE|ILIKE|!=|<>).*$/i, '').trim().toLowerCase();
      if (['and', 'or', 'not', 'now', 'null', 'true', 'false', 'excluded'].includes(col)) continue;
      // Skip if it was already captured as qualified
      if (col.includes('.')) continue;
      addCol(defaultTable, col);
    }
  }

  // Convert map to array
  return Array.from(tableColumns.entries()).map(([table, cols]) => ({
    table,
    columns: Array.from(cols),
  }));
}

describe('Scheduled Invoke Schema Validation', () => {
  let schema: Map<string, Set<string>>;

  beforeAll(() => {
    schema = buildSchemaFromMigrations();
  });

  it('should have all tables referenced in the execution path', () => {
    const requiredTables = [
      'agents', 'threads', 'invocations', 'messages', 'compiled_instructions',
      'cached_entitlements', 'cached_agent_quotas', 'tenant_oversight_cache',
      'memories', 'usage_events', 'burn_state', 'actions', 'workflow_tasks',
      'workflows', 'tenants', 'kill_switches', 'audit_logs',
    ];

    const missingTables: string[] = [];
    for (const table of requiredTables) {
      if (!schema.has(table)) {
        missingTables.push(table);
      }
    }

    expect(missingTables).toEqual([]);
  });

  it('should have workflow_steps column on agents table', () => {
    const agentCols = schema.get('agents');
    expect(agentCols).toBeDefined();
    expect(agentCols!.has('workflow_steps')).toBe(true);
  });

  it('should have is_external_write column on actions table', () => {
    const actionCols = schema.get('actions');
    expect(actionCols).toBeDefined();
    expect(actionCols!.has('is_external_write')).toBe(true);
  });

  it('should have started_at column on workflow_tasks table', () => {
    const taskCols = schema.get('workflow_tasks');
    expect(taskCols).toBeDefined();
    expect(taskCols!.has('started_at')).toBe(true);
  });

  it('should have kill_switches table', () => {
    expect(schema.has('kill_switches')).toBe(true);
  });

  it('should have all columns referenced in critical execution path files', () => {
    const criticalFiles = [
      'src/handlers/scheduled-invoke-handler.ts',
      'src/agent-execution/service.ts',
      'src/invocations/service.ts',
      'src/admission/service.ts',
      'src/usage-ledger/repository.ts',
      'src/action-ledger/repository.ts',
      'src/agent-lifecycle/service.ts',
      'src/agent-lifecycle/repository.ts',
      'src/entitlements-client/repository.ts',
    ];

    const mismatches: string[] = [];

    for (const file of criticalFiles) {
      const fullPath = path.join(__dirname, '../../..', file);
      if (!fs.existsSync(fullPath)) continue;

      const queries = extractQueriesFromFile(fullPath);

      for (const { query, line } of queries) {
        const refs = parseColumnsFromQuery(query);
        for (const { table, columns } of refs) {
          const tableCols = schema.get(table);
          if (!tableCols) continue;
          // Only validate tables on the critical scheduled-invoke path
          const criticalTables = ['agents', 'threads', 'invocations', 'messages',
            'compiled_instructions', 'cached_entitlements', 'cached_agent_quotas',
            'cached_model_configs', 'tenant_oversight_cache', 'usage_events',
            'burn_state', 'actions', 'workflow_tasks', 'workflows', 'kill_switches',
            'audit_logs', 'tenants'];
          if (!criticalTables.includes(table)) continue;

          for (const col of columns) {
            if (['count', 'coalesce', 'extract', 'epoch', 'now', 'interval'].includes(col)) continue;
            if (col.startsWith('$') || col.startsWith("'") || col.includes(')') || col.includes('}')) continue;
            // Skip partial word matches from string values in SQL
            if (col.length < 3) continue;
            // Skip known parser false positives (partial matches from SQL string literals)
            if (col.endsWith('_d') || col === 'mill' || col === 'pend' || col === 'runn') continue;

            if (!tableCols.has(col)) {
              mismatches.push(`${file}:${line} - ${table}.${col} does not exist in migrations`);
            }
          }
        }
      }
    }

    if (mismatches.length > 0) {
      // Test diagnostic only — surfaces the exact mismatch when the assertion below fails.
      // eslint-disable-next-line r5/no-console-in-src
      console.error('Schema mismatches found:\n' + mismatches.join('\n'));
    }
    expect(mismatches).toEqual([]);
  });
});

// ── The parser's own blind spot ─────────────────────────────────────────────
//
// `ALTER TABLE t ADD COLUMN a …, ADD COLUMN b …;` is ONE statement with two
// columns. The parser used to capture the first and drop the rest, so every
// column after the first in a multi-column ALTER was unknown to the gate — and
// a query naming one of them passed unchecked, which is the exact failure this
// file exists to catch. Silent in both directions: no error, just fewer columns
// known than the schema has.
describe('the migration parser reads every column it is given', () => {
  const parse = (sql: string): Set<string> => {
    const fsMod = require('fs');
    const osMod = require('os');
    const pathMod = require('path');
    const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'schema-parse-'));
    try {
      fsMod.writeFileSync(pathMod.join(dir, '001_test.sql'), sql);
      // buildSchemaFromMigrations is the function under test; it takes a dir.
      return buildSchemaFromMigrations(dir).get('widgets') ?? new Set<string>();
    } finally {
      fsMod.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads a single-column ALTER', () => {
    const cols = parse('ALTER TABLE widgets ADD COLUMN IF NOT EXISTS alpha text;');
    expect([...cols]).toEqual(['alpha']);
  });

  it('reads EVERY column of a multi-column ALTER', () => {
    const cols = parse(`
      ALTER TABLE widgets
        ADD COLUMN IF NOT EXISTS alpha text,
        ADD COLUMN IF NOT EXISTS beta  integer,
        ADD COLUMN IF NOT EXISTS gamma jsonb;
    `);
    expect([...cols].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('reads columns across several ALTERs in one file', () => {
    const cols = parse(`
      ALTER TABLE widgets ADD COLUMN IF NOT EXISTS alpha text;
      ALTER TABLE widgets ADD COLUMN IF NOT EXISTS beta integer, ADD COLUMN gamma jsonb;
    `);
    expect([...cols].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  // An ALTER that adds no column must not create an empty table entry: an empty
  // entry makes every column of that table read as missing.
  it('ignores an ALTER that adds no column', () => {
    const cols = parse(`
      ALTER TABLE widgets ADD CONSTRAINT widgets_alpha_positive CHECK (alpha > 0);
    `);
    expect([...cols]).toEqual([]);
  });

  // The two migrations this change shipped, asserted directly rather than
  // trusted: both are multi-column, and both are on tables the gate checks.
  it('knows every provider-failure column added to invocations', () => {
    const schema = buildSchemaFromMigrations();
    const invocations = schema.get('invocations') ?? new Set<string>();
    for (const col of [
      'provider_failure_kind', 'provider_error_type', 'provider_status', 'provider_request_id',
    ]) {
      expect(invocations.has(col)).toBe(true);
    }
  });

  it('knows every canonical-artifact column added to the session tables', () => {
    const schema = buildSchemaFromMigrations();
    for (const table of ['chat_sessions', 'agent_run_sessions']) {
      const cols = schema.get(table) ?? new Set<string>();
      for (const col of ['canonical_content', 'canonical_schema_version', 'canonical_sha256']) {
        expect(cols.has(col)).toBe(true);
      }
    }
  });
});
