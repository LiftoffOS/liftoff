// Do the recall statements MEAN what they say? Run them against a migrated
// workforce database, with rows, and assert the answers.
//
// NOT PART OF `npm test`, deliberately: this suite has no database, and a test
// that cannot run is worse than one that is absent because it reads as coverage.
// Run it by hand, or from a migration gate, against a throwaway database:
//
//   npm run build
//   DATABASE_URL=postgres://.../workforce node scripts/verify-recall-sql.mjs
//
// Exit 0 means every assertion held; exit 1 names the ones that did not.
//
// The unit suite (src/__tests__/caio-recall-conversations.test.ts) covers the
// DECISIONS around these statements — the bounds, the escaping, which arm runs.
// It cannot cover these properties, which is why this file exists.
//
// The statements are imported from the COMPILED module, so what runs here is
// exactly what ships. A mocked client pins a statement's text and can say nothing
// about whether Postgres will take it OR about which rows it returns: the errors
// that matter (a lateral on the wrong alias, a DISTINCT ON whose ORDER BY does not
// lead with it, a parameter passed and never referenced, a scope that leaks) come
// from parse analysis and from data.
import pg from 'pg';
import { randomUUID } from 'crypto';
import { KEYWORD_SQL, SEMANTIC_SQL } from '../dist/workforce-plans/tools/recall-conversations.js';

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const ME = randomUUID();
const COLLEAGUE = randomUUID();
const ZERO = `[${Array(768).fill(0).join(',')}]`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const failures = [];

function check(name, condition, detail) {
  if (condition) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

async function thread(tenantId, title) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO team_plan_threads (id, tenant_id, account_id, title) VALUES ($1, $2, $3, $4)`,
    [id, tenantId, ME, title],
  );
  return id;
}

/** A turn with MANY messages, where only the last contains the term. This is the
 *  shape that exposed the preview-ordering defect: the keyword arm matches on any
 *  message in the turn, but the excerpt used to show the first six in time order,
 *  so the matching message never appeared and the hit looked irrelevant. */
async function longTurn(tenantId, threadId, accountId, filler, needleText, at) {
  const turnId = randomUUID();
  await pool.query(
    `INSERT INTO team_plan_turns (id, tenant_id, thread_id, account_id, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [turnId, tenantId, threadId, accountId, at],
  );
  await pool.query(
    `INSERT INTO team_plan_messages (thread_id, role, content, turn_id, created_at)
     VALUES ($1, 'user', $2, $3, $4)`,
    [threadId, filler, turnId, at],
  );
  // Seven more plain rows, the term only in the last.
  for (let i = 1; i <= 7; i++) {
    await pool.query(
      `INSERT INTO team_plan_messages (thread_id, role, content, turn_id, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [threadId, i % 2 ? 'assistant' : 'user', i === 7 ? needleText : `${filler} ${i}`,
       turnId, new Date(at.getTime() + i * 1000)],
    );
  }
  return turnId;
}

/** One turn: the turn row, the person's message, the reply. `type` makes the
 *  reply narration rather than speech. */
async function turn(tenantId, threadId, accountId, said, replied, at, opts = {}) {
  const turnId = randomUUID();
  await pool.query(
    `INSERT INTO team_plan_turns (id, tenant_id, thread_id, account_id, created_at,
       content_embedding, content_embedding_provider, content_embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [turnId, tenantId, threadId, accountId, at,
     opts.embed ? ZERO : null, opts.embed ? 'google' : null, opts.embed ? 'gemini-embedding-001' : null],
  );
  await pool.query(
    `INSERT INTO team_plan_messages (thread_id, role, content, turn_id, created_at)
     VALUES ($1, 'user', $2, $3, $4)`,
    [threadId, said, turnId, at],
  );
  await pool.query(
    `INSERT INTO team_plan_messages (thread_id, role, content, turn_id, message_type, created_at)
     VALUES ($1, 'assistant', $2, $3, $4, $5)`,
    [threadId, replied, turnId, opts.replyType ?? null, new Date(at.getTime() + 1000)],
  );
  return turnId;
}

const T = (n) => new Date(Date.UTC(2026, 8, 1, n, 0, 0));

try {
  const mine = await thread(TENANT, 'Invoice chasing');
  const alsoMine = await thread(TENANT, 'Payroll questions');
  const theirs = await thread(TENANT, 'A colleague thread');
  const elsewhere = await thread(OTHER_TENANT, 'Another workspace');

  const invoiceTurn = await turn(TENANT, mine, ME, 'set up the invoice chasing team', 'done', T(1), { embed: true });
  await turn(TENANT, alsoMine, ME, 'what about payroll', 'here it is', T(2), { embed: true });
  // Same conversation, same topic again: the semantic arm must not return both.
  await turn(TENANT, mine, ME, 'more about invoice chasing', 'noted', T(3), { embed: true });
  // A colleague's turn in a workspace-shared thread.
  await turn(TENANT, theirs, COLLEAGUE, 'the invoice chasing team again', 'sure', T(4), { embed: true });
  // Another tenant entirely.
  await turn(OTHER_TENANT, elsewhere, ME, 'invoice chasing elsewhere', 'ok', T(5), { embed: true });
  // Narration as the reply: it must not appear in a preview.
  const narrated = await turn(TENANT, alsoMine, ME, 'invoice status please', 'Waiting on an approval', T(6), { replyType: 'hitl_status' });

  const kw = (params) => pool.query(KEYWORD_SQL, params).then((r) => r.rows);
  const sem = (params) => pool.query(SEMANTIC_SQL, params).then((r) => r.rows);

  // Scope: my turns only, this tenant only.
  const mineOnly = await kw([TENANT, ME, 10, 'invoice', null, '%invoice%']);
  check('returns only my own turns', mineOnly.every((r) => r.thread_id !== theirs),
    `got threads ${mineOnly.map((r) => r.thread_id).join(', ')}`);
  check('never crosses the tenant', mineOnly.every((r) => r.thread_id !== elsewhere));
  check('finds my matching turns', mineOnly.length === 3, `got ${mineOnly.length}`);

  // The excluded turn.
  const excluded = await kw([TENANT, ME, 10, 'invoice', invoiceTurn, '%invoice%']);
  check('excludes the executing turn', !excluded.some((r) => r.turn_id === invoiceTurn));

  // Narration stays out of the previews.
  const narratedHit = (await kw([TENANT, ME, 10, 'invoice', null, '%invoice status%']))[0];
  check('a narration reply is not quoted as speech',
    narratedHit && !JSON.stringify(narratedHit.messages).includes('Waiting on an approval'),
    JSON.stringify(narratedHit?.messages));
  check('the person\'s own words survive beside it',
    narratedHit && JSON.stringify(narratedHit.messages).includes('invoice status please'));

  // Recent mode: newest first, no query.
  const recent = await kw([TENANT, ME, 10, null, null, null]);
  check('recent mode is newest first',
    recent.length >= 2 && new Date(recent[0].created_at) > new Date(recent[1].created_at));
  check('recent mode returns every one of my turns', recent.length === 4, `got ${recent.length}`);

  // A deleted conversation disappears.
  await pool.query(`UPDATE team_plan_threads SET deleted_at = NOW() WHERE id = $1`, [alsoMine]);
  const afterDelete = await kw([TENANT, ME, 10, null, null, null]);
  check('a deleted conversation is gone', !afterDelete.some((r) => r.thread_id === alsoMine));

  // Semantic: one hit per conversation, and space-gated.
  const semantic = await sem([TENANT, ME, 10, 'invoice', null, ZERO, 'google', 'gemini-embedding-001']);
  const threads = semantic.map((r) => r.thread_id);
  check('at most one hit per conversation', new Set(threads).size === threads.length,
    `got ${threads.join(', ')}`);
  const wrongSpace = await sem([TENANT, ME, 10, 'invoice', null, ZERO, 'openai', 'text-embedding-3-small']);
  check('a vector from another space is never compared', wrongSpace.length === 0,
    `got ${wrongSpace.length} rows`);

  // The preview-ordering fix: a match past the per-hit bound must still be shown.
  const deep = await thread(TENANT, 'A long exchange');
  await longTurn(TENANT, deep, ME, 'routine chatter', 'the quarterly budget figure is 42', T(9));
  const deepHit = (await kw([TENANT, ME, 10, 'quarterly budget', null, '%quarterly budget%']))
    .find((r) => r.thread_id === deep);
  check('a match past the per-hit bound is shown, not buried',
    deepHit && JSON.stringify(deepHit.messages).includes('quarterly budget'),
    deepHit ? JSON.stringify(deepHit.messages).slice(0, 200) : 'no hit returned');
  check('and the excerpts stay in reading order',
    deepHit && (() => {
      const times = deepHit.messages.map((m) => m.created_at);
      return times.every((t, i) => i === 0 || t >= times[i - 1]);
    })());

  if (failures.length === 0) console.log('ALL_CAIO_SEMANTICS_HELD');
  else { console.error(`${failures.length} assertion(s) failed`); process.exitCode = 1; }
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
