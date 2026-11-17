// PR 0.3 chat-service branch contract.
//
// Booting runCAIOChatTurn in isolation pulls in DB pools, fetch-mocking for
// the connector service, and the streaming-visualization parser — too much
// to mock cleanly. We instead lock the source-level contract:
//
//   - greetingMode is decided by an empty userMessage
//   - greeting mode hands `tools: []` to runPlatformAgent (no tool round trips)
//   - non-greeting mode passes the role-filtered availableTools
//   - the user message is appended ONLY when non-greeting
//   - the platform-agent dispatch site uses usagePurpose='caio_workforce_planning'
//
// These five checks would catch the regressions the integration test would
// catch, with none of the boot overhead.

import { readFileSync } from 'fs';
import { join } from 'path';

const CHAT_SERVICE = readFileSync(
  join(__dirname, '..', 'workforce-plans', 'chat-service.ts'),
  'utf-8',
);

describe('PR 0.3 chat-service branch contract', () => {
  it('decides greetingMode from an empty userMessage, unless the turn is the person\'s browser event', () => {
    // A hand-back or a point arrives without words and is a turn of its own,
    // never the greeting: the model reads the shared event text instead. So
    // is a continuation of work a bound closed, which arrives without words
    // and reads the continuation note.
    expect(CHAT_SERVICE).toMatch(
      /const\s+eventOnly\s*=\s*continuation\s*===\s*null\s*&&\s*input\.browserEvent\s*!==\s*undefined\s*&&\s*\(!input\.userMessage\s*\|\|\s*input\.userMessage\.trim\(\)\.length\s*===\s*0\)/,
    );
    expect(CHAT_SERVICE).toMatch(
      /const\s+greetingMode\s*=\s*continuation\s*===\s*null\s*&&\s*!eventOnly\s*&&\s*\(!input\.userMessage\s*\|\|\s*input\.userMessage\.trim\(\)\.length\s*===\s*0\)/,
    );
  });

  it('hands runPlatformAgent an empty tools list in greeting mode', () => {
    // The chat-service must select between `[]` and `availableTools` based on
    // the greetingMode boolean, then assign to a `toolsForRun` variable that
    // feeds runPlatformAgent's tools field.
    expect(CHAT_SERVICE).toMatch(/const\s+toolsForRun\s*=\s*greetingMode\s*\?\s*\[\]\s*:\s*availableTools/);
    expect(CHAT_SERVICE).toMatch(/tools:\s*toolsForRun/);
  });

  it('appends the user message only outside greeting mode, and never for a browser event without words', () => {
    // The if-guard around appendMessage for the user turn must check
    // `!greetingMode` and `!eventOnly`: an event turn's row is the status
    // line naming what the person did, and the model-facing text is not
    // theirs to see. `!continuation`: a continuation writes no user row; its
    // note is model-only and the origin message already stands.
    expect(CHAT_SERVICE).toMatch(/if\s*\(!greetingMode\s*&&\s*!eventOnly\s*&&\s*!continuation\)\s*\{/);
  });

  // The threadless greeting: said, not filed. Nothing thread-scoped may run
  // for it, because there is no thread to scope to — and nothing may be
  // written, because a greeting nobody answered is not a conversation.
  it('appends the assistant reply only when there is a thread to append it to', () => {
    expect(CHAT_SERVICE).toMatch(
      /const\s+savedMessage\s*=\s*input\.threadId\s*\?\s*await\s+appendMessage/,
    );
    expect(CHAT_SERVICE).toMatch(/:\s*null;/);
  });

  it('loads no history, summary, linked plan or last-reply time without a thread', () => {
    expect(CHAT_SERVICE).toMatch(
      /const\s+\[historyResult,\s*summary,\s*linkedPlan,\s*sinceLastReply\]\s*=\s*input\.threadId\s*\?/,
    );
    // The Browser section and the datasets inventory are thread-scoped too:
    // platform-backend renders both for the thread, and a threadless greeting
    // has neither.
    expect(CHAT_SERVICE).toMatch(
      /const\s+\[browserContext,\s*datasetContext\]\s*=\s*input\.threadId\s*\?\s*await\s+Promise\.all\(\[\s*fetchBrowserState\(\{\s*tenantId:\s*input\.tenantId,\s*threadId:\s*input\.threadId\s*\},\s*sinceLastReply\),\s*fetchDatasetInventory\(\{\s*tenantId:\s*input\.tenantId,\s*threadId:\s*input\.threadId\s*\}\),\s*\]\)\s*:\s*\['',\s*''\]/,
    );
    expect(CHAT_SERVICE).toMatch(/buildBudgetedCAIOPrompt\(\{[\s\S]{0,400}\.\.\.\(browserContext\s*\?\s*\{\s*browserContext\s*\}\s*:\s*\{\}\)/);
    expect(CHAT_SERVICE).toMatch(/buildBudgetedCAIOPrompt\(\{[\s\S]{0,500}\.\.\.\(datasetContext\s*\?\s*\{\s*datasetContext\s*\}\s*:\s*\{\}\)/);
  });

  it('claims no turn and records no events without a thread', () => {
    // The recorder and the turn claim are both thread-scoped, so a threadless
    // greeting delegates straight to the core and returns.
    expect(CHAT_SERVICE).toMatch(
      /if\s*\(!threadId\)\s*\{\s*yield\*\s*runCAIOChatTurnCore\(input,\s*turnId\);\s*return;\s*\}/,
    );
  });

  it('refreshes no rolling summary without a thread', () => {
    expect(CHAT_SERVICE).toMatch(
      /if\s*\(input\.threadId\)\s*\{\s*fireAndForget\(\s*maybeRefreshRollingSummary/,
    );
  });
});

describe('the threadless greeting keeps its workspace grounding', () => {
  // The point of the CAIO greeting is that it is NOT a clock string: it reads
  // the tenant's connectors and existing agents and speaks to them. Dropping
  // the thread must not drop that, so the pre-fetch stays tenant-scoped.
  it('opens every greeting with the product\'s own sentence, word for word', () => {
    // The rest of the greeting is the model's; the first sentence is not.
    // Left to the model it drifted to positioning the site no longer uses.
    const opening = 'I am your Chief AI Officer, here to take the work you hand off and make sure an agent owns it.';
    expect(CHAT_SERVICE).toContain(`export const CAIO_GREETING_OPENING =\n  '${opening}';`);
    expect(CHAT_SERVICE).toMatch(/The first sentence is exactly this, word for word: "\$\{CAIO_GREETING_OPENING\}"/);
    // Product voice: no contractions, no em dashes.
    expect(opening).not.toMatch(/\u2014/);
    expect(opening).not.toMatch(/\b\w+n't\b|\b\w+'(re|ll|ve|d|s|m)\b/);
  });

  it('pre-fetches workspace context from the tenant, not the thread', () => {
    expect(CHAT_SERVICE).toMatch(
      /effectiveUserMessage\s*=\s*await\s+prefetchGreetingContext\(input\.tenantId\)/,
    );
  });

  it('dispatches runPlatformAgent with usagePurpose="caio_workforce_planning"', () => {
    expect(CHAT_SERVICE).toMatch(
      /runPlatformAgent[\s\S]{0,4000}usagePurpose:\s*['"]caio_workforce_planning['"]/,
    );
  });

  it('renders the seed system prompt up-front so the budget accounts for it', () => {
    expect(CHAT_SERVICE).toMatch(/renderSystemPrompt\(\s*caioConfig\.systemPromptTemplate/);
    expect(CHAT_SERVICE).toMatch(
      /buildBudgetedCAIOPrompt\(\{[\s\S]{0,400}systemPrompt:\s*renderedSystemPrompt/,
    );
  });
});

describe("the person's browser events on the Chief AI Officer's thread", () => {
  it('writes the status line in the person\'s name before their message, typed as the shared row types', () => {
    expect(CHAT_SERVICE).toMatch(/if\s*\(input\.browserEvent\s*&&\s*input\.threadId\)\s*\{/);
    expect(CHAT_SERVICE).toContain('`${who} handed the browser back`');
    expect(CHAT_SERVICE).toContain('`${who} ${describeAction(input.browserEvent.action)}`');
    expect(CHAT_SERVICE).toMatch(
      /messageType:\s*input\.browserEvent\.kind\s*===\s*'point'\s*\?\s*BROWSER_POINT_MESSAGE_TYPE\s*:\s*BROWSER_HANDBACK_MESSAGE_TYPE/,
    );
  });

  it('gives the model the shared event text when the person sent no words', () => {
    expect(CHAT_SERVICE).toMatch(
      /else\s+if\s*\(eventOnly\)\s*\{[\s\S]{0,400}effectiveUserMessage\s*=\s*input\.browserEvent!\.kind\s*===\s*'point'\s*\?\s*BROWSER_POINT_TURN_TEXT\s*:\s*BROWSER_HANDBACK_TURN_TEXT/,
    );
  });

  it('keeps both event rows out of the model\'s history and the rolling summary', () => {
    expect(CHAT_SERVICE.split('.filter(m => m.messageType !== BROWSER_HANDBACK_MESSAGE_TYPE)').length - 1).toBe(2);
    expect(CHAT_SERVICE.split('.filter(m => m.messageType !== BROWSER_POINT_MESSAGE_TYPE)').length - 1).toBe(2);
    // An event turn persisted only its status line, so every history row is a prior turn.
    expect(CHAT_SERVICE).toMatch(/const\s+priorTurns\s*=\s*greetingMode\s*\|\|\s*eventOnly\s*\|\|\s*continuation\s*\n?\s*\?\s*historyOldestFirst/);
  });
});
