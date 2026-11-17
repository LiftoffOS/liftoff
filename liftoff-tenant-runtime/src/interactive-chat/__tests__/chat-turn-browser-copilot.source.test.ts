/**
 * The browser copilot's chat-turn contract (static source contract).
 *
 * Two things the handler promises and nothing else can see:
 *
 *   1. The Browser section is appended AFTER the prior-work block and BEFORE
 *      the skill block, only when the thread has a session or a record, and
 *      never fails the turn.
 *   2. A hand-back or a point event turn arrives with an EMPTY userMessage
 *      beside `browserHandback`; the model reads the shared
 *      text, spelled once in @liftoffos/browser-record, and the runtime's own
 *      history keeps that text as the user row, because it is what the model
 *      read. A plain turn with nothing to say is still refused.
 *
 * The handler cannot be imported here (it pulls DB + SDK transitively), so
 * this asserts the structure directly, in the spirit of the other
 * `*.source.test.ts` contracts in this directory.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { BROWSER_HANDBACK_TURN_TEXT, BROWSER_POINT_TURN_TEXT } from '@liftoffos/browser-record';

const SOURCE = readFileSync(join(__dirname, '..', 'chat-turn-handler.ts'), 'utf8');

describe('the Browser section in the chat prompt', () => {
  it('is appended after the prior-work block and before the skill block', () => {
    const priorAt = SOURCE.indexOf('renderPriorWorkBlock(await priorWork(');
    const browserAt = SOURCE.indexOf('buildBrowserStateBlock({');
    const skillsAt = SOURCE.indexOf("buildSkillContextBlock(chatSkills, skillDisclosureMode())");
    expect(priorAt).toBeGreaterThan(-1);
    expect(browserAt).toBeGreaterThan(priorAt);
    expect(skillsAt).toBeGreaterThan(browserAt);
  });

  it('is appended only when the block is non-empty, and a failure is non-fatal', () => {
    expect(SOURCE).toMatch(/if \(browserBlock\) systemPrompt \+= '\\n\\n' \+ browserBlock;/);
    const block = SOURCE.slice(SOURCE.indexOf('buildBrowserStateBlock({'), SOURCE.indexOf('browser state injection failed'));
    expect(block).toContain('catch (err)');
  });

  it('hands the driver\'s name from the request to the block', () => {
    expect(SOURCE).toContain('browserDriverName: z.string().max(200).optional()');
    expect(SOURCE).toMatch(/driverName: browserDriverName/);
  });
});

describe('the hand-back event turn', () => {
  it('accept an empty userMessage only beside browserHandback', () => {
    expect(SOURCE).toContain('browserHandback: browserEventSchema.optional()');
    expect(SOURCE).toContain('const browserEventSchema = z.object({ holdId: z.string().uuid() });');
    expect(SOURCE).toMatch(/b\.userMessage\.length > 0 \|\| b\.browserHandback !== undefined/);
  });

  it('the model-facing message is the shared text, and it is what the history keeps as the user row', () => {
    expect(SOURCE).toContain("import { BROWSER_HANDBACK_TURN_TEXT } from '@liftoffos/browser-record';");
    expect(SOURCE).toMatch(/body\.userMessage \|\| \(browserEvent === 'handback' \? BROWSER_HANDBACK_TURN_TEXT : ''\)/);
    // The substitution happens BEFORE the message is used: every later read
    // of `userMessage` (the model, the history row) sees the shared text.
    const substitutionAt = SOURCE.indexOf("browserEvent === 'handback' ? BROWSER_HANDBACK_TURN_TEXT");
    const firstUse = SOURCE.indexOf('matchesStopText(userMessage)');
    const historyRow = SOURCE.indexOf(".addMessage({ tenantId, threadId, role: 'user', content: userMessage");
    expect(substitutionAt).toBeGreaterThan(-1);
    expect(firstUse).toBeGreaterThan(substitutionAt);
    expect(historyRow).toBeGreaterThan(substitutionAt);
  });

  it('the shared texts are the package\'s, spelled once', () => {
    expect(BROWSER_HANDBACK_TURN_TEXT).toContain('handed the browser back');
    expect(BROWSER_POINT_TURN_TEXT).toBe(
      'The person pointed at something in the browser; the Browser section names it. Treat it as the thing they mean in their last message, or ask what they would like done with it.',
    );
    for (const text of [BROWSER_HANDBACK_TURN_TEXT, BROWSER_POINT_TURN_TEXT]) {
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/\bagent\b/i);
    }
  });
});
