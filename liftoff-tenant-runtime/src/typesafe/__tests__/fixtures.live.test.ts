// The fixture contract test: every recorded fixture under
// src/typesafe/fixtures/<item>/ against the LIVE vendor, on the pinned model.
//
//   LIVE_TESTS=true TYPESAFE_API_KEY=... npx jest fixtures.live
//
// Gated the way this runtime's other live tests are: it runs only when
// LIVE_TESTS=true, and the key comes from TYPESAFE_API_KEY. The
// `typesafe-contract` step in cloudbuild.yaml supplies both and FAILS THE
// BUILD when the key is missing or unreadable, because the phases whose kills
// default on ship with this evidence.
//
// Two things are asserted per fixture: it is pinned to the CURRENT set
// (version and model — anything else is "re-pin required"), and the answers
// meet its expectations at the pinned thresholds. The browser_step fixtures
// are built from a recorded page exactly as the loop builds a request, and
// their target expectations name the control by its text. Then, per set,
// the tightest passing band is printed; a person reads it and pins the
// threshold in questions.ts. The test never pins anything itself.

import { join } from 'path';
import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from '@typesafe-ai/sdk';
import {
  ASK_CHECK_SET,
  BROWSER_GOAL_CHECK_SET,
  contractCheckSet,
  memorySaveSet,
  memoryUsedSet,
  messageCheckSet,
  MESSAGE_CHECK_NOULS,
  UNTRUSTED_CONTENT_HARMFUL_LABELS,
  UNTRUSTED_CONTENT_SET,
  type QuestionSet,
} from '../questions';
import { SEMANTIC_MIN_CHARS } from '../../injection-detection/finding';
import { MEMORY_KINDS, USER_MODEL_FACETS } from '../../memory/curation';
import { buildStepRequest } from '../../integrations/web-fetch/jev-loop/decide';
import { extractLiterals } from '../../integrations/web-fetch/jev-loop/literals';
import type { PageState, HistoryEntry } from '../../integrations/web-fetch/jev-loop/types';
import {
  checkExpectations,
  formatBands,
  loadFixtures,
  repinReason,
  targetIdByElement,
  tightestBands,
  type AnswerLike,
  type Fixture,
  type FixtureExpectation,
} from './fixture-runner';

// Skipped, not failed, without both: a developer box rarely holds the key.
// The build step supplies both and fails the build without the key, so the
// contract cannot skip itself where it matters.
const live = process.env.LIVE_TESTS === 'true' && !!process.env.TYPESAFE_API_KEY;
const maybe = live ? describe : describe.skip;

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function client(): TypeSafeClient {
  return new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY!, logLevel: 'off', retry: { maxRetries: 0 }, timeout: 15_000 });
}

/** The vendor's transient refusals: overloaded (529), rate limited (429) and
 *  the 5xx family. This suite judges the fixture bands, not the vendor's
 *  uptime, so such an answer is asked again after a pause, a bounded number
 *  of times; anything else, and the last transient, fail as before. The
 *  runtime client keeps its own rule (connect and 429 only). */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const TRANSIENT_RETRIES = 5;

/** The vendor will not answer, and no amount of waiting changes that.
 *
 *  402 is an unpaid account: "Your organization has no available TypeSafe API
 *  credits." It is NOT in TRANSIENT_STATUSES, correctly — retrying a payment
 *  refusal cannot succeed and would only spend calls on an account that has
 *  none. But it belongs in the same OUTCOME as a 503, because the question this
 *  suite exists to ask was never put to anything: a 402 says exactly as much
 *  about whether a fixture band moved as a DNS failure does, which is nothing.
 *
 *  Otherwise an unpaid account fails every fixture 402 and blocks the release
 *  of unrelated fixes this contract has no opinion about.
 *  run-typesafe-contract.sh opens with that exact
 *  scenario — "What is NOT deliberate is a vendor outage blocking a billing fix
 *  from reaching production" — and the three-state contract was already built
 *  for it; 402 simply never reached the branch that reports it.
 *
 *  So: sentinel immediately, no retries, and the build is told INCONCLUSIVE and
 *  says so loudly. The fixtures ship UNJUDGED, which is the honest description
 *  of what happened and is visible in the build log rather than inferred. */
const UNPAYABLE_STATUSES = new Set([402]);
const statusOf = (err: unknown): number | undefined => {
  const e = err as { status?: unknown; statusCode?: unknown };
  const s = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (s !== undefined) return s;
  // 402 joins the pattern. The SDK sets `status`, so this fallback is for an
  // error that only carries the code in its text — and a 402 that is not
  // recognised here fails as a fixture breach, which is the one wrong answer.
  const m = /\b(402|429|5[0-9]{2})\b/.exec((err as Error)?.message ?? '');
  return m ? Number(m[1]) : undefined;
};

/** The request never reached the vendor's application, or never came back.
 *
 *  Carries NO status, which is why it used to bypass the retry above and fail on
 *  the first occurrence: `statusOf` returns undefined and the guard treats an
 *  unknown error as a real one. A DNS failure, a refused connection, a TLS
 *  handshake and a client-side timeout say exactly as much about a fixture band
 *  as a 503 does — nothing — so they are asked again on the same schedule.
 *
 *  The runtime client deliberately keeps a NARROWER rule (connect and 429 only,
 *  never a timeout) because a retried billable call there could double-charge.
 *  Nothing here is billed to a customer, so this suite judges what it is for. */
const isUnreachable = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name ?? '';
  const code = (err as { code?: string })?.code ?? '';
  const message = (err as Error)?.message ?? '';
  return (
    /APIConnectionError|APITimeoutError|APIConnectionTimeoutError/.test(name)
    || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|CERT_|ERR_TLS/.test(code)
    || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network error|fetch failed|terminated/i.test(message)
  );
};

/** Printed once, when the vendor never answered after every retry.
 *
 *  The CI wrapper reads this line to tell "the vendor was down" from "a fixture
 *  band moved". The first is not evidence about this contract and must not block
 *  a deploy; the second is the whole reason the contract exists and must. Kept as
 *  a literal sentinel rather than inferred from the failure text, because the
 *  failure text is the vendor's and can change without notice.
 *  See scripts/ci/run-typesafe-contract.sh. */
export const VENDOR_UNAVAILABLE_SENTINEL = 'TYPESAFE_CONTRACT_VENDOR_UNAVAILABLE';
async function askSet<Q extends Questions>(c: TypeSafeClient, set: QuestionSet<Q>, state: EntryType): Promise<SystemOneResult<Q>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await c.systemOne({ state, questions: set.questions, model: set.model }, { retry: { maxRetries: 0 } });
    } catch (err) {
      const status = statusOf(err);
      // Before the transient test, and without consuming an attempt: there is
      // nothing to wait for.
      if (status !== undefined && UNPAYABLE_STATUSES.has(status)) {
        console.log(`${VENDOR_UNAVAILABLE_SENTINEL}: vendor refused on ${status} and will not answer until it is settled (${(err as Error)?.message ?? err})`);
        throw err;
      }
      const transient = (status !== undefined && TRANSIENT_STATUSES.has(status)) || isUnreachable(err);
      if (!transient) throw err;
      if (attempt >= TRANSIENT_RETRIES) {
        // Out of attempts on something that was never about the fixtures. Say so
        // in the one form the CI wrapper reads, then fail as before — a local run
        // still sees a failure, and only CI acts on the distinction.
        console.log(`${VENDOR_UNAVAILABLE_SENTINEL}: gave up after ${TRANSIENT_RETRIES} retries (${status ?? 'no status'}: ${(err as Error)?.message ?? err})`);
        throw err;
      }
      const pauseMs = Math.min(30_000, 2_000 * 2 ** attempt);
      const what = status !== undefined ? `vendor answered ${status}` : `vendor unreachable (${(err as Error)?.message ?? err})`;
      console.log(`${what}; asking again in ${pauseMs} ms (attempt ${attempt + 1} of ${TRANSIENT_RETRIES})`);
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
}
const answersOf = (r: SystemOneResult<Questions>): Record<string, AnswerLike> => r.answers as unknown as Record<string, AnswerLike>;

/** Run one directory: build the set per fixture, pin-check, ask, check. */
async function runDirectory(
  c: TypeSafeClient,
  dir: string,
  build: (f: Fixture) => { set: QuestionSet; state: EntryType; expect: Record<string, FixtureExpectation> } | null,
  label: string,
  bands: { questions: string[]; labels: string[] } | null,
): Promise<void> {
  const fixtures = loadFixtures(join(FIXTURES_DIR, dir));
  expect(fixtures.length).toBeGreaterThan(0);
  const failures: string[] = [];
  const observations: Array<{ answers: Record<string, AnswerLike>; expect: Record<string, FixtureExpectation> }> = [];
  for (const f of fixtures) {
    const built = build(f);
    // Null: not this set's fixture (the browser directory holds two sets).
    if (!built) continue;
    const repin = repinReason(f, built.set);
    if (repin) { failures.push(`${f.file}: ${repin}`); continue; }
    const result = await askSet(c, built.set, built.state);
    if (result.model !== built.set.model) { failures.push(`${f.file}: model ${result.model} is not ${built.set.model}`); continue; }
    const answers = answersOf(result);
    observations.push({ answers, expect: built.expect });
    const { misses, advisories } = checkExpectations(answers, built.expect);
    if (advisories.length > 0) {
        console.log(`${label} ${f.file}: advisory: ${advisories.join('; ')}`);
    }
    if (misses.length > 0) failures.push(`${f.file}: ${misses.join('; ')}`);
    console.log(`  ${label} ${f.file}: ${Object.entries(built.expect).map(([q]) => {
      const a = answers[q];
      const p = typeof a?.noul === 'number' ? a.noul : a?.probabilities?.[a?.choice ?? ''];
      return `${q}=${a?.choice ?? (typeof a?.noul === 'number' ? 'noul' : '?')}@${typeof p === 'number' ? p.toFixed(3) : '?'}`;
    }).join(' ')}`);
  }
  if (bands) {
    console.log(formatBands(label, tightestBands(observations, bands.questions, bands.labels)));
  }
  if (failures.length > 0) throw new Error(`${failures.length} of ${fixtures.length} ${label} fixtures failed:\n${failures.join('\n')}`);
}

maybe('TypeSafe fixture contract (live vendor, pinned model)', () => {
  jest.setTimeout(300_000);
  // Built inside the block: the constructor refuses a missing key, and a
  // skipped suite must still load.
  let c: TypeSafeClient;
  beforeAll(() => { c = client(); });

  it('browser_step: recorded pages with must-click / must-type / must-select expectations', async () => {
    await runDirectory(c, 'browser', (f) => {
      if (f.set.id !== 'browser_step') return null;
      const built = buildStepRequest(f.page as PageState, f.goal ?? '', (f.history ?? []) as HistoryEntry[], extractLiterals(f.goal ?? '', f.parameters));
      // Target expectations name the control by text; resolve to the index
      // the built request offers.
      const expectations: Record<string, FixtureExpectation> = {};
      for (const [q, exp] of Object.entries(f.expect)) {
        if (q.endsWith('_target') && exp.label) {
          const head = (built.set.questions as Record<string, { criteria: Record<string, { element?: string }> }>)[q];
          const id = head ? targetIdByElement(head.criteria, exp.label) : undefined;
          expectations[q] = { ...exp, label: undefined, choice: id ?? `(no control says "${exp.label}")` };
        } else {
          expectations[q] = exp;
        }
      }
      return { set: built.set as unknown as QuestionSet, state: built.state, expect: expectations };
    }, 'browser_step', null);
  });

  it('browser_goal_check: final observations with met / not-met expectations, pinning GOAL_T', async () => {
    await runDirectory(c, 'browser', (f) => (f.set.id === 'browser_goal_check'
      ? { set: BROWSER_GOAL_CHECK_SET as unknown as QuestionSet, state: f.state as EntryType, expect: f.expect }
      : null),
    'browser_goal_check', { questions: ['goal_met'], labels: ['true'] });
  });

  it('contract_check: pinning OUTSIDE_T', async () => {
    await runDirectory(c, 'contract-check', (f) => {
      const calls = (f.state as { calls: unknown[] }).calls;
      return { set: contractCheckSet(calls.length) as unknown as QuestionSet, state: f.state as EntryType, expect: f.expect };
    }, 'contract_check', { questions: ['relation_0'], labels: ['within', 'outside', 'unclear'] });
  });

  it('ask_check: pinning SELF_ANSWER_T and NOT_ACTIONABLE_T', async () => {
    await runDirectory(c, 'ask-check', (f) => ({ set: ASK_CHECK_SET as unknown as QuestionSet, state: f.state as EntryType, expect: f.expect }),
      'ask_check', { questions: ['answerable_from_context', 'person_can_act', 'answer_source'], labels: ['yes', 'no', 'unclear', 'inputs', 'step_output', 'instructions', 'none'] });
  });

  it('memory_save: pinning ADMIT_REFUSE_T, KIND_T, CLASS_T, SUPERSEDE_T', async () => {
    await runDirectory(c, 'memory-save', (f) => {
      const neighbours = (f.state as { neighbours: unknown[] }).neighbours;
      return { set: memorySaveSet(MEMORY_KINDS, USER_MODEL_FACETS, neighbours.length) as unknown as QuestionSet, state: f.state as EntryType, expect: f.expect };
    }, 'memory_save', { questions: ['admit', 'kind', 'facet', 'classification', 'relation_0'], labels: ['task_state', 'already_in_instructions', 'durable_knowledge', 'about_a_person', 'fact', 'user_model', 'communication_style', 'working_hours', 'pii', 'sensitive', 'internal', 'supersedes', 'contradicts', 'unrelated'] });
  });

  it('memory_used: pinning USED_T', async () => {
    await runDirectory(c, 'memory-used', (f) => {
      const memories = (f.state as { memories: unknown[] }).memories;
      return { set: memoryUsedSet(memories.length) as unknown as QuestionSet, state: f.state as EntryType, expect: f.expect };
    }, 'memory_used', { questions: ['used_0', 'used_1', 'used_2'], labels: ['true'] });
  });

  it('untrusted_content: directives and ordinary material, pinning CONTENT_T', async () => {
    const fixtures = loadFixtures(join(FIXTURES_DIR, 'untrusted-content'));
    expect(fixtures.length).toBeGreaterThan(0);
    /** Harmful when the label it states is one of the two the rule sums.
     *  Derived from `expect` rather than declared beside it: two statements of
     *  the same fact are two things that can disagree. */
    const isHarmful = (f: Fixture): boolean =>
      (UNTRUSTED_CONTENT_HARMFUL_LABELS as readonly string[]).includes(f.expect.content_kind?.choice ?? '');
    expect(fixtures.filter(isHarmful).length).toBeGreaterThan(0);
    expect(fixtures.filter((f) => !isHarmful(f)).length).toBeGreaterThan(0);
    // A fixture below the size floor pins a screen that would never run on it.
    for (const f of fixtures) {
      expect(((f.state as { content: string }).content ?? '').length).toBeGreaterThanOrEqual(SEMANTIC_MIN_CHARS);
    }

    const contentT = UNTRUSTED_CONTENT_SET.thresholds.CONTENT_T as number;
    const failures: string[] = [];
    // A label disagreement on the same side of the decision is reported, not
    // failed: content that both overrides the task AND asks for private data
    // is genuinely both labels. What is never advisory is the verdict below.
    const advisories: string[] = [];
    // Computed here, not through `tightestBands`: the shared helper reports one
    // label at a time and counts every other label as "not expected", so it
    // would read an `external_directive` fixture as evidence AGAINST
    // `sensitive_data_directive` — which for a summed rule is worse than none.
    const harmfulOnHarmful: number[] = [];
    const harmfulOnBenign: number[] = [];
    for (const f of fixtures) {
      const repin = repinReason(f, UNTRUSTED_CONTENT_SET as unknown as QuestionSet);
      if (repin) { failures.push(`${f.file}: ${repin}`); continue; }
      const result = await askSet(c, UNTRUSTED_CONTENT_SET as unknown as QuestionSet, f.state as EntryType);
      if (result.model !== UNTRUSTED_CONTENT_SET.model) {
        failures.push(`${f.file}: model ${result.model} is not ${UNTRUSTED_CONTENT_SET.model}`);
        continue;
      }
      const answers = answersOf(result);
      const checked = checkExpectations(answers, f.expect);
      const misses = checked.misses;
      if (checked.advisories.length > 0) advisories.push(`${f.file}: ${checked.advisories.join('; ')}`);

      const p = answers.content_kind?.probabilities ?? {};
      const harmful = UNTRUSTED_CONTENT_HARMFUL_LABELS.reduce((sum, label) => sum + (p[label] ?? 0), 0);
      (isHarmful(f) ? harmfulOnHarmful : harmfulOnBenign).push(harmful);

      const raises = harmful >= contentT;
      if (raises !== isHarmful(f)) {
        misses.push(`at CONTENT_T=${contentT} the screen ${raises ? 'raises' : 'raises no'} finding, `
          + `fixture states ${isHarmful(f) ? 'a finding' : 'none'} `
          + `(p(external_directive)+p(sensitive_data_directive)=${harmful.toFixed(3)})`);
      }
      if (misses.length > 0) failures.push(`${f.file}: ${misses.join('; ')}`);
    }
    console.log(
      'untrusted_content: p(external_directive)+p(sensitive_data_directive) band (pin CONTENT_T between them)\n'
      + `  min over the ${harmfulOnHarmful.length} harmful fixtures = ${harmfulOnHarmful.length ? Math.min(...harmfulOnHarmful).toFixed(3) : 'n/a'}\n`
      + `  max over the ${harmfulOnBenign.length} benign fixtures  = ${harmfulOnBenign.length ? Math.max(...harmfulOnBenign).toFixed(3) : 'n/a'}`,
    );
    if (advisories.length > 0) {
      console.log(`untrusted_content: ${advisories.length} advisory label disagreements (reported, not failed):\n${advisories.join('\n')}`);
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${fixtures.length} untrusted_content fixtures failed:\n${failures.join('\n')}`);
    }
  });

  it('message_check: at least fifteen per category in both directions, pinning UNSAFE_T and CLEAR_T', async () => {
    const fixtures = loadFixtures(join(FIXTURES_DIR, 'message-check'));
    for (const key of Object.keys(MESSAGE_CHECK_NOULS)) {
      const noul = MESSAGE_CHECK_NOULS[key].noul;
      const ofCategory = fixtures.filter((f) => (f.state as { ticked: string[] }).ticked.includes(key));
      const bad = ofCategory.filter((f) => f.expect[noul]?.min !== undefined).length;
      const clear = ofCategory.filter((f) => f.expect[noul]?.max !== undefined).length;
      expect(ofCategory.length).toBeGreaterThanOrEqual(15);
      expect(bad).toBeGreaterThan(0);
      expect(clear).toBeGreaterThan(0);
    }
    await runDirectory(c, 'message-check', (f) => {
      const ticked = (f.state as { ticked: string[] }).ticked;
      return { set: messageCheckSet(ticked) as unknown as QuestionSet, state: f.state as EntryType, expect: f.expect };
    }, 'message_check', { questions: Object.values(MESSAGE_CHECK_NOULS).map((n) => n.noul), labels: ['true'] });
  });
});
