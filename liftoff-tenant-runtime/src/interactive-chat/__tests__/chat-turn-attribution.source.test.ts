/**
 * Hand-over attribution (static source contract).
 *
 * A chat turn that hands work to a teammate through `delegate_to_agent` is
 * attributed to that teammate twice: live, as a `delegation_started` frame the
 * relay promotes from the tool call through the gateway's own label -> id map,
 * and persisted, as `delegatedTo` on every writer of the turn's speech.
 *
 * The persisted list comes from the durable record of the delegations that
 * actually RAN (delegation_active), never from the tool calls the model
 * emitted: the model's tool_use block fires before any human gate, so a list
 * built from emitted calls would attribute a reply to a teammate a gate
 * refused. It is read once, after the run, and must reach BOTH terminal
 * branches — the pause frames and the paused settle as well as the complete
 * frame and the final settle — because a reply that paused for a question is
 * attributed exactly like one that finished, and a person who closed the tab
 * reads the row the settle callback wrote.
 *
 * The handler cannot be imported here (it pulls DB + SDK transitively), so this
 * asserts the structure directly, in the same spirit as the other
 * `*.source.test.ts` contracts in this directory. The pure translation is
 * covered by chat-event-relay.test.ts; the durable read by
 * agent-execution/__tests__/delegated-agents.test.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'chat-turn-handler.ts'), 'utf8');
const SERVICE = readFileSync(join(__dirname, '..', '..', 'agent-execution', 'service.ts'), 'utf8');

describe('live attribution resolves the teammate through the gateway\'s own roster', () => {
  it('hands the relay the label -> id map the delegate_to_agent enum was built from', () => {
    expect(SOURCE).toMatch(/delegateIdByLabel\s*\}\s*=\s*\n?\s*await agentExecutionService\.buildChatToolCatalog\(/);
    expect(SOURCE).toMatch(/const delegateIdForTeammate = \(teammate: string\) => delegateIdByLabel\.get\(teammate\)/);
    expect(SOURCE).toMatch(/invocationEventToChatFrame\(event, \{ traceMode, delegateIdForTeammate \}\)/);
  });
});

describe('persisted attribution has one durable origin', () => {
  it('reads delegatedTo from delegation_active once, after the run and before the terminal branches', () => {
    const read = SOURCE.indexOf('const delegatedTo = await listDelegatedAgentIds(tenantId, invocationId);');
    const paused = SOURCE.indexOf('if (execResult.paused) {');
    expect(read).toBeGreaterThan(-1);
    expect(paused).toBeGreaterThan(read);
    expect(SOURCE.match(/const delegatedTo = /g)).toHaveLength(1);
  });

  it('never derives it from the tool calls the model emitted', () => {
    expect(SOURCE).not.toMatch(/collectedToolCalls[\s\S]{0,200}delegate_to_agent[\s\S]{0,200}delegatedTo/);
    expect(SOURCE).not.toMatch(/delegatedTo[\s\S]{0,200}collectedToolCalls/);
  });
});

describe('delegatedTo reaches every writer of the turn\'s speech', () => {
  it('rides the final settle callback', () => {
    const settle = SOURCE.match(/await settleChatTurnViaCallback\(\{[\s\S]*?final: true,[\s\S]*?\}\);/);
    expect(settle).not.toBeNull();
    expect(settle![0]).toMatch(/\n\s*delegatedTo,\n/);
  });

  it('rides the paused settle callback', () => {
    const settle = SOURCE.match(/await settleChatTurnViaCallback\(\{[\s\S]*?replyText: assistantTurn,[\s\S]*?\}\);/);
    expect(settle).not.toBeNull();
    expect(settle![0]).toMatch(/\n\s*delegatedTo,\n/);
  });

  it('rides the complete frame', () => {
    const complete = SOURCE.match(/await writeSSE\(res, 'complete', \{[\s\S]*?outputText: persistedReply,[\s\S]*?\}\);/);
    expect(complete).not.toBeNull();
    expect(complete![0]).toMatch(/\n\s*delegatedTo,\n/);
  });

  it('rides the hitl_required and awaiting_input frames, the two pauses that persist speech', () => {
    const hitl = SOURCE.match(/await writeSSE\(res, 'hitl_required', \{[\s\S]*?\}\);/);
    expect(hitl).not.toBeNull();
    expect(hitl![0]).toMatch(/\n\s*delegatedTo,\n/);
    const asking = SOURCE.match(/await writeSSE\(res, 'awaiting_input', \{[\s\S]*?\}\);/);
    expect(asking).not.toBeNull();
    expect(asking![0]).toMatch(/\n\s*delegatedTo,\n/);
  });
});

describe('a continuation delivered later is attributed like a streamed reply', () => {
  it('the HITL resume settlement carries the resumed invocation\'s delegations', () => {
    const close = SERVICE.match(/private async closeMcpChatRunForResume\([\s\S]*?\n {2}\}\n/);
    expect(close).not.toBeNull();
    expect(close![0]).toContain('listDelegatedAgentIds(tenantId, invocationId)');
    expect(close![0]).toMatch(/settleMcpChatRunViaCallback\(\{[^}]*delegatedTo[^}]*\}\)/);
  });

  it('every wake settlement of a model-authored reply carries them too', () => {
    const settles = [...SERVICE.matchAll(/await settleWakeViaCallback\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
    expect(settles.length).toBe(3);
    for (const call of settles) expect(call).toMatch(/delegatedTo/);
  });
});
