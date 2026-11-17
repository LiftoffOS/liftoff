import { buildCapabilityStepPrompt, buildCapabilityWebFallbackPrompt } from '../capability-step-prompt';
import type { WorkflowCapabilityNeed } from '../../types';

describe('buildCapabilityStepPrompt', () => {
  const need: WorkflowCapabilityNeed = {
    operation: 'send text message',
    entity: 'message',
    mode: 'own_account',
    targetSystem: 'sms',
    requiredOutputFields: ['messageId', 'status'],
  };

  it('directs the two-call capability_search → run_capability sequence with the need and args', () => {
    const p = buildCapabilityStepPrompt(need, { to: '+14155551234', body: 'Your order shipped' }, 'Text the customer their update');
    // Names both tools so a model reaches for them rather than refusing.
    expect(p).toContain('capability_search');
    expect(p).toContain('run_capability');
    // Carries the structured, vendor-agnostic need.
    expect(p).toContain('"send text message"');
    expect(p).toContain('"message"');
    expect(p).toContain('"own_account"');
    expect(p).toContain('"sms"');
    expect(p).toContain('"messageId"');
    // Carries the call args as the step's values, to be passed under the
    // capability's own argument names — never verbatim, since a value under
    // a name the capability does not list is ignored.
    expect(p).toContain('"to":"+14155551234"');
    expect(p).toContain('"body":"Your order shipped"');
    expect(p).not.toContain('verbatim');
    expect(p).toContain("pass each value under the capability's name for it");
    expect(p).toContain('pass nothing under a name the capability does not list');
    // Carries the authored goal.
    expect(p).toContain('Text the customer their update');
    // Sets the approval expectation so a write-class pause is not read as an error.
    expect(p.toLowerCase()).toContain('approval');
    // MUST NOT contradict invokeStepLLM's output contract: an outputField step's
    // final action is a record_step_output call, so the prompt cannot cap the
    // tool calls or forbid "other" tools — that made the model skip the recording
    // and return prose that outputField extraction rejects.
    expect(p.toLowerCase()).not.toContain('exactly two');
    expect(p.toLowerCase()).not.toContain('no other tool');
  });

  it('with no declared arguments, has the model build them from the goal and the listed args rather than run with none', () => {
    // A capability run with `{}` searches for nothing: a keyword search
    // returned an empty list and the step recorded it as the pull.
    const p = buildCapabilityStepPrompt(need, {}, 'Pull up to 10 recent public posts mentioning Shopify from the last 7 days');
    expect(p).not.toContain('verbatim');
    expect(p).toContain('This step declares no arguments');
    expect(p).toContain('the search term or keyword the goal names, the limit it states');
    expect(p).toContain('Invent nothing the goal does not say.');
  });

  it('names no vendor and omits absent optional fields', () => {
    const readNeed: WorkflowCapabilityNeed = { operation: 'enrich person', entity: 'profiles', mode: 'public_data' };
    const p = buildCapabilityStepPrompt(readNeed, {}, 'Enrich the lead');
    expect(p).toContain('"enrich person"');
    // Optional fields absent → not rendered.
    expect(p).not.toContain('targetSystem');
    expect(p).not.toContain('availableInputs');
    expect(p).not.toContain('requiredOutputFields');
    // Empty args are not passed as an empty object to run with: the model is
    // told to build them.
    expect(p).not.toContain('{}');
    expect(p).toContain('This step declares no arguments');
  });

  it('is byte-stable for identical inputs (cacheable prefix)', () => {
    const a = buildCapabilityStepPrompt(need, { to: 'x' }, 'g');
    const b = buildCapabilityStepPrompt(need, { to: 'x' }, 'g');
    expect(a).toBe(b);
  });
});

// The second turn a capability step gets when its first produced nothing
// useful: web tools only, the same need and values, what the first attempt
// produced, and no vendor and no cause anywhere in it.
describe('buildCapabilityWebFallbackPrompt', () => {
  const need: WorkflowCapabilityNeed = {
    operation: 'search posts', entity: 'posts', mode: 'public_data', targetSystem: 'tiktok', requiredOutputFields: ['url', 'text'],
  };

  it('says the library could not meet the need and points at the web tools, with the need, values and required fields', () => {
    const p = buildCapabilityWebFallbackPrompt(need, { keyword: 'shopify', limit: 5 }, 'Find the latest posts about the product', 'Nothing came back from the capability library.');
    expect(p).toContain("The capability library could not meet this step's need");
    expect(p).toContain('web tools');
    expect(p).toContain('search posts posts on tiktok');
    expect(p).toContain('"keyword":"shopify"');
    expect(p).toContain('["url","text"]');
    expect(p).toContain('Nothing came back from the capability library.');
    expect(p).toContain('record the result if asked');
    expect(p).not.toContain('capability_search');
    expect(p).not.toContain('run_capability');
  });

  it('with no declared values, takes them from the goal and invents nothing', () => {
    const p = buildCapabilityWebFallbackPrompt(need, {}, 'Find posts', undefined);
    expect(p).toContain('The step declares no values');
    expect(p).toContain('invent nothing');
    expect(p).not.toContain('What the first attempt produced');
  });

  it('names no vendor, forbids speculating about the cause, and bounds the first turn\'s text', () => {
    const long = 'x'.repeat(5_000);
    const p = buildCapabilityWebFallbackPrompt(need, { q: 'a' }, 'goal', long);
    expect(p.toLowerCase()).not.toMatch(/tikhub|apify|strale|nasdaq|gloria|credit|balance|outage/);
    expect(p).toContain('Do not state, guess or speculate about why the earlier attempt found nothing');
    expect(p.length).toBeLessThan(2_500);
    expect(p).toContain('…');
  });

  it('is byte-stable for identical inputs', () => {
    const a = buildCapabilityWebFallbackPrompt(need, { q: 'a' }, 'goal', { posts: [] });
    const b = buildCapabilityWebFallbackPrompt(need, { q: 'a' }, 'goal', { posts: [] });
    expect(a).toBe(b);
  });
});
