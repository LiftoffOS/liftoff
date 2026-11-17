// The fixture contract test: every recorded fixture under
// src/typesafe/fixtures/<item>/ against the LIVE vendor, on the pinned model.
//
// Runs in the integration jest config (it needs no database, and the unit
// suite must never reach a vendor). The key comes from TYPESAFE_API_KEY. The
// `typesafe-contract` step in cloudbuild.yaml supplies it and FAILS THE BUILD
// when the key is missing or unreadable, because the phases whose kills
// default on ship with this evidence; a developer box without the key skips
// with a loud reason rather than pretending.
//
// Two things are asserted per fixture: it is pinned to the CURRENT set
// (version and model — anything else is "re-pin required"), and the answers
// meet its expectations at the pinned thresholds. The classifier fixtures are
// also run through the band rule so the categories and the effect class the
// classifier would store equal what the fixture states.
//
// Then, per set, the tightest passing band is printed: the lowest probability
// seen where a label was expected, and the highest where it was not. A person
// reads the two, pins the threshold between them in questions.ts, and commits
// it. The test never pins anything itself.

import { join } from 'path';
import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from '@typesafe-ai/sdk';
import {
  CLASSIFIER_CATEGORIES,
  CLASSIFIER_SET,
  distillBindSet,
  INJECTION_GUARD_HARMFUL_LABELS,
  INJECTION_GUARD_SET,
  routeMessageSet,
  type QuestionSet,
} from '../questions';
import { effectClassFromBands, includedByBands } from '../../mcp/tool-classifier';
import { checkExpectations, formatBands, loadFixtures, repinReason, tightestBands, type Fixture, type AnswerLike } from './fixture-runner';

const KEY = process.env.TYPESAFE_API_KEY;
const describeFn = KEY ? describe : describe.skip;
if (!KEY) {
  console.warn('fixtures.integration.test.ts: TYPESAFE_API_KEY is unset — the vendor contract is NOT being checked on this box. CI supplies the key and fails without it.');
}

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function client(): TypeSafeClient {
  return new TypeSafeClient({ apiKey: KEY!, logLevel: 'off', retry: { maxRetries: 0 }, timeout: 15_000 });
}

// The vendor's own capacity is not a verdict on this repo's fixtures.
//
// This suite asks a live model once per fixture. Without a retry it can fail
// a build, and block every backend deploy, on `529 We are currently
// experiencing high traffic ... Please try again later` — the vendor saying,
// in words, that the right move is to ask again — and adding fixtures without
// moving the clock can push it past its own time budget.
//
// The tenant runtime's copy of this contract carries the same retry. Same
// statuses, same backoff, same cap.
// Nothing here changes a threshold, an expectation or what any fixture
// asserts: a vendor that answers 429 or a 5xx is asked again, and a vendor
// that answers is judged exactly as before.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const TRANSIENT_RETRIES = 5;
const statusOf = (err: unknown): number | undefined => {
  const e = err as { status?: unknown; statusCode?: unknown };
  const s = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (s !== undefined) return s;
  const m = /\b(429|5[0-9]{2})\b/.exec((err as Error)?.message ?? '');
  return m ? Number(m[1]) : undefined;
};

async function askSet<Q extends Questions>(c: TypeSafeClient, set: QuestionSet<Q>, state: EntryType): Promise<SystemOneResult<Q>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await c.systemOne({ state, questions: set.questions, model: set.model }, { retry: { maxRetries: 0 } });
    } catch (err) {
      const status = statusOf(err);
      if (attempt >= TRANSIENT_RETRIES || status === undefined || !TRANSIENT_STATUSES.has(status)) throw err;
      const pauseMs = Math.min(30_000, 2_000 * 2 ** attempt);
      console.log(`vendor answered ${status}; asking again in ${pauseMs} ms (attempt ${attempt + 1} of ${TRANSIENT_RETRIES})`);
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
}

function answersOf(result: SystemOneResult<Questions>): Record<string, AnswerLike> {
  return result.answers as unknown as Record<string, AnswerLike>;
}

describeFn('TypeSafe fixture contract (live vendor, pinned model)', () => {
  // Raised with the suite rather than with the machine: 9d59d89f took the
  // fixture count past what 120 s could serve, and the retry above can now
  // spend up to a minute of backoff on one badly timed 529.
  jest.setTimeout(600_000);
  const c = client();

  describe('classifier', () => {
    const fixtures = loadFixtures(join(FIXTURES_DIR, 'classifier'));
    const observations: Array<{ answers: Record<string, AnswerLike>; expect: Fixture['expect']; file: string }> = [];
    it('has fixtures', () => { expect(fixtures.length).toBeGreaterThan(0); });

    for (const f of fixtures) {
      it(`${f.file}: pinned to the current set`, () => {
        expect(repinReason(f, CLASSIFIER_SET)).toBeNull();
      });
    }

    it('every fixture meets its expectations at the pinned thresholds, and the band rule stores what it states', async () => {
      const t = CLASSIFIER_SET.thresholds as Record<string, number>;
      const failures: string[] = [];
      const advisories: string[] = [];
      for (const f of fixtures) {
        const result = await askSet(c, CLASSIFIER_SET, f.state as EntryType);
        expect(result.model).toBe(CLASSIFIER_SET.model);
        const answers = answersOf(result);
        observations.push({ answers, expect: f.expect, file: f.file });
        const checked = checkExpectations(answers, f.expect);
        const misses = checked.misses;
        // The band rule, as the classifier applies it: every category the
        // fixture requires is stored; a category the fixture forbids
        // (a binding "no") is not.
        const included = CLASSIFIER_CATEGORIES.filter((cat) => includedByBands(answers[cat].probabilities!.yes, t.INCLUDE_T, t.EXCLUDE_T));
        const required = CLASSIFIER_CATEGORIES.filter((cat) => f.expect[cat]?.choice === 'yes' && !f.expect[cat]?.advisory);
        const advisedYes = CLASSIFIER_CATEGORIES.filter((cat) => f.expect[cat]?.choice === 'yes' && f.expect[cat]?.advisory);
        const forbidden = CLASSIFIER_CATEGORIES.filter((cat) => f.expect[cat]?.choice === 'no' && !f.expect[cat]?.advisory);
        for (const cat of required) if (!included.includes(cat)) misses.push(`band rule omits ${cat}, which the fixture requires`);
        for (const cat of advisedYes) if (!included.includes(cat)) checked.advisories.push(`band rule omits ${cat} (advisory)`);
        for (const cat of forbidden) if (included.includes(cat)) misses.push(`band rule stores ${cat}, which the fixture forbids`);
        const effectExp = f.expect.effect;
        if (effectExp?.choice) {
          const stored = effectClassFromBands(
            answers.effect.probabilities as Record<'read' | 'write' | 'destructive' | 'outbound' | 'unclear', number>,
            included.length === 0, t.EFFECT_READ_T, t.EFFECT_T,
          );
          // A read the fixture states with a category stored beside it is
          // never stored as read: the band rule, not a miss.
          const expectedStored = effectExp.choice === 'read' && included.length > 0 ? null : effectExp.choice;
          if (stored !== expectedStored) {
            (effectExp.advisory ? advisories : misses).push(`band rule stores effect ${stored}, fixture states ${expectedStored}`);
          }
        }
        if (checked.advisories.length > 0) advisories.push(`${f.file}: ${checked.advisories.join('; ')}`);
        if (misses.length > 0) failures.push(`${f.file}: ${misses.join('; ')}`);
      }
      console.log(formatBands('classifier', tightestBands(observations, [...CLASSIFIER_CATEGORIES, 'effect'], ['yes', 'no', 'read', 'write', 'destructive', 'outbound', 'unclear'])));
      if (advisories.length > 0) {
        console.log(`classifier: ${advisories.length} advisory disagreements (reported, not failed):\n${advisories.join('\n')}`);
      }
      if (failures.length > 0) {
        throw new Error(`${failures.length} of ${fixtures.length} classifier fixtures failed:\n${failures.join('\n')}`);
      }
    });
  });

  describe('distill_bind', () => {
    const fixtures = loadFixtures(join(FIXTURES_DIR, 'distill-bind'));
    it('every fixture is pinned and meets its expectations above BIND_T', async () => {
      const failures: string[] = [];
      const observations: Array<{ answers: Record<string, AnswerLike>; expect: Fixture['expect'] }> = [];
      for (const f of fixtures) {
        const candidates = ((f.state as { candidates: Array<{ key: string; description: string; inputSchema?: Record<string, unknown> }> }).candidates);
        const set = distillBindSet(candidates);
        const repin = repinReason(f, set);
        if (repin) { failures.push(`${f.file}: ${repin}`); continue; }
        const result = await askSet(c, set, f.state as EntryType);
        const answers = answersOf(result);
        observations.push({ answers, expect: f.expect });
        const { misses } = checkExpectations(answers, f.expect);
        const a = answers.binding;
        const bindT = set.thresholds.BIND_T as number;
        const applied = a.choice !== 'none' && (a.probabilities?.[a.choice!] ?? 0) >= bindT ? a.choice : 'none';
        if (applied !== f.expect.binding.choice) misses.push(`at BIND_T=${bindT} the rung applies ${applied}, fixture states ${f.expect.binding.choice}`);
        if (misses.length > 0) failures.push(`${f.file}: ${misses.join('; ')}`);
      }
      console.log(formatBands('distill_bind', tightestBands(observations, ['binding'], ['none'])));
      for (const o of observations) {
        const a = o.answers.binding;
        console.log(`  distill_bind chose ${a.choice} at ${(a.probabilities?.[a.choice!] ?? 0).toFixed(3)} (expected ${o.expect.binding.choice})`);
      }
      if (failures.length > 0) throw new Error(`${failures.length} of ${fixtures.length} distill_bind fixtures failed:\n${failures.join('\n')}`);
    });
  });

  describe('injection_guard', () => {
    const fixtures = loadFixtures(join(FIXTURES_DIR, 'injection-guard'));
    /** A fixture is harmful when the label it states is one of the two the
     *  guard sums. Derived from `expect` rather than declared beside it: two
     *  statements of the same fact is two things that can disagree. */
    const isHarmful = (f: Fixture): boolean =>
      (INJECTION_GUARD_HARMFUL_LABELS as readonly string[]).includes(f.expect.message_kind?.choice ?? '');

    it('has at least fifteen fixtures in each direction', () => {
      expect(fixtures.filter(isHarmful).length).toBeGreaterThanOrEqual(15);
      expect(fixtures.filter((f) => !isHarmful(f)).length).toBeGreaterThanOrEqual(15);
    });

    for (const f of fixtures) {
      it(`${f.file}: pinned to the current set`, () => {
        expect(repinReason(f, INJECTION_GUARD_SET)).toBeNull();
      });
    }

    it('every fixture meets its expectations, and the summed rule at GUARD_BLOCK_T decides what it states', async () => {
      const blockT = INJECTION_GUARD_SET.thresholds.GUARD_BLOCK_T as number;
      const failures: string[] = [];
      // A label disagreement on the same side of the decision is reported, not
      // failed — `jailbreak` versus `prompt_injection` on a smuggled override,
      // `ordinary` versus `mention_only` on a quoted error. The fixtures that
      // sit on such a boundary say so with `advisory`, and what is never
      // advisory is the verdict below, which is what the guard actually does.
      const advisories: string[] = [];
      // The band is computed HERE rather than through `tightestBands`, and the
      // difference is not a style one: the shared helper reports one label at a
      // time and counts every other label as "not expected", so it would read a
      // `jailbreak` fixture as evidence AGAINST `prompt_injection` — which for a
      // rule that sums the two is worse than no evidence at all.
      const harmfulOnHarmful: number[] = [];
      const harmfulOnBenign: number[] = [];
      for (const f of fixtures) {
        const result = await askSet(c, INJECTION_GUARD_SET, f.state as EntryType);
        expect(result.model).toBe(INJECTION_GUARD_SET.model);
        const answers = answersOf(result);
        const checked = checkExpectations(answers, f.expect);
        const misses = checked.misses;

        const p = answers.message_kind?.probabilities ?? {};
        const harmful = INJECTION_GUARD_HARMFUL_LABELS.reduce((sum, label) => sum + (p[label] ?? 0), 0);
        (isHarmful(f) ? harmfulOnHarmful : harmfulOnBenign).push(harmful);

        // The decision the guard would actually take, under the pinned
        // threshold, against what the fixture states. Never advisory: this is
        // the whole of what the branch does with the answer.
        const unsafe = harmful >= blockT;
        if (unsafe !== isHarmful(f)) {
          misses.push(`at GUARD_BLOCK_T=${blockT} the guard calls it ${unsafe ? 'unsafe' : 'safe'}, `
            + `fixture states ${isHarmful(f) ? 'unsafe' : 'safe'} (p(jailbreak)+p(prompt_injection)=${harmful.toFixed(3)})`);
        }
        if (checked.advisories.length > 0) advisories.push(`${f.file}: ${checked.advisories.join('; ')}`);
        if (misses.length > 0) failures.push(`${f.file}: ${misses.join('; ')}`);
      }
      // Printed for a person to pin GUARD_BLOCK_T between the two. The test
      // never pins anything itself.
      console.log(
        'injection_guard: p(jailbreak)+p(prompt_injection) band (pin GUARD_BLOCK_T between them)\n'
        + `  min over the ${harmfulOnHarmful.length} harmful fixtures = ${harmfulOnHarmful.length ? Math.min(...harmfulOnHarmful).toFixed(3) : 'n/a'}\n`
        + `  max over the ${harmfulOnBenign.length} benign fixtures  = ${harmfulOnBenign.length ? Math.max(...harmfulOnBenign).toFixed(3) : 'n/a'}`,
      );
      if (advisories.length > 0) {
        console.log(`injection_guard: ${advisories.length} advisory label disagreements (reported, not failed):\n${advisories.join('\n')}`);
      }
      if (failures.length > 0) {
        throw new Error(`${failures.length} of ${fixtures.length} injection_guard fixtures failed:\n${failures.join('\n')}`);
      }
    });
  });

  describe('route_message', () => {
    const fixtures = loadFixtures(join(FIXTURES_DIR, 'route-message'));
    it('every fixture is pinned and meets its expectations above ROUTE_T', async () => {
      const failures: string[] = [];
      const observations: Array<{ answers: Record<string, AnswerLike>; expect: Fixture['expect'] }> = [];
      for (const f of fixtures) {
        const candidates = (f.state as { candidates: Array<{ id: string; role: string; summary: string }> }).candidates;
        const set = routeMessageSet(candidates);
        const repin = repinReason(f, set);
        if (repin) { failures.push(`${f.file}: ${repin}`); continue; }
        const result = await askSet(c, set, f.state as EntryType);
        const answers = answersOf(result);
        observations.push({ answers, expect: f.expect });
        const { misses } = checkExpectations(answers, f.expect);
        const a = answers.answerer;
        const routeT = set.thresholds.ROUTE_T as number;
        const applied = a.choice !== 'none' && (a.probabilities?.[a.choice!] ?? 0) >= routeT ? a.choice : 'none';
        if (applied !== f.expect.answerer.choice) misses.push(`at ROUTE_T=${routeT} the rung answers ${applied}, fixture states ${f.expect.answerer.choice}`);
        if (misses.length > 0) failures.push(`${f.file}: ${misses.join('; ')}`);
      }
      console.log(formatBands('route_message', tightestBands(observations, ['answerer'], ['none'])));
      for (const o of observations) {
        const a = o.answers.answerer;
        console.log(`  route_message chose ${a.choice} at ${(a.probabilities?.[a.choice!] ?? 0).toFixed(3)} (expected ${o.expect.answerer.choice})`);
      }
      if (failures.length > 0) throw new Error(`${failures.length} of ${fixtures.length} route_message fixtures failed:\n${failures.join('\n')}`);
    });
  });
});
