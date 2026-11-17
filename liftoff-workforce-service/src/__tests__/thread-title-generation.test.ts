// CAIO thread titles.
//
// A title asked for as prose and parsed with JSON.parse leaves threads reading
// "Untitled Chat". On a short exchange the model returns bare JSON and it works;
// on a real one it wraps the object in a ```json fence, the parse throws, and an
// empty catch swallows it. Platform-backend's generator forces a responseSchema,
// so it does not have the problem; this service's copy must do the same.
//
// These tests assert the contract that removes the failure mode: the title call
// must force structured output, and it must carry the tenant so the cost lands
// on the right workspace.

import { readFileSync } from 'fs';
import { join } from 'path';
import { redactSensitiveText } from '@liftoffos/redact';

const CHAT_SERVICE = readFileSync(
  join(__dirname, '..', 'workforce-plans', 'chat-service.ts'),
  'utf-8',
);
const THREAD_TITLE = readFileSync(
  join(__dirname, '..', 'workforce-plans', 'thread-title.ts'),
  'utf-8',
);
const LLM_CLIENT = readFileSync(join(__dirname, '..', 'llm', 'client.ts'), 'utf-8');
const BACKFILL = readFileSync(
  join(__dirname, '..', 'scripts', 'backfill-thread-titles.ts'),
  'utf-8',
);

describe('CAIO thread title generation', () => {
  it('uses the shared generator rather than a local copy', () => {
    // The fork is what produced the bug: its own prompt asked for prose and its
    // own parser choked when the model fenced the JSON. Platform-backend's agent
    // chat has always used this shared core; now so does the CAIO.
    expect(THREAD_TITLE).toMatch(/from '@liftoffos\/service-runtime'/);
    expect(THREAD_TITLE).toMatch(/sharedMaybeGenerateThreadTitle\(/);
    // chat-service holds no arrangement of its own; it imports the adapter.
    expect(CHAT_SERVICE).toMatch(/from '\.\/thread-title\.js'/);
    // The copied prompt and parser must be gone, not merely repaired.
    expect(CHAT_SERVICE).not.toContain('You are a conversation title generator.');
    expect(CHAT_SERVICE).not.toMatch(/JSON\.parse\(rawText\)/);
  });

  it('forces structured output instead of parsing prose', () => {
    // The whole bug in one assertion: without responseSchema the model is free
    // to fence its JSON, and it does.
    expect(THREAD_TITLE).toMatch(/responseSchema:\s*\{[\s\S]*?name:\s*'thread_title'/);
    expect(THREAD_TITLE).toMatch(/required:\s*\['title'\]/);
  });

  it('attributes the title call to the tenant', () => {
    // Otherwise the row lands in llm_usage_log with no tenant and the cost
    // never reaches the workspace that incurred it.
    expect(THREAD_TITLE).toMatch(/tenantId:\s*params\.tenantId/);
  });

  it('logs a title failure rather than swallowing it', () => {
    // The empty `catch {}` is why this survived unnoticed for months.
    expect(THREAD_TITLE).not.toMatch(/\}\s*catch\s*\{\s*\/\/ Never throws — title generation is best-effort\s*\}/);
    expect(THREAD_TITLE).toMatch(/thread title generation failed/i);
  });

  it('the relay client actually forwards responseSchema and tenantId', () => {
    // A schema the client drops on the floor would leave the model free-form
    // again, with the call site looking correct.
    // The shape comes from @liftoffos/shared-types now, not a local
    // re-declaration — so assert the field is declared AND that it is the
    // shared type. That is the stronger property: a hand-written copy is
    // exactly how harvest-service ended up sending a bare JSON Schema with
    // no `name`, which the relay turns into tool_choice.name and the vendor
    // rejects. Same reasoning as the '@liftoffos/redact' assertion below.
    expect(LLM_CLIENT).toMatch(/responseSchema\?:\s*LLMWireResponseSchema/);
    expect(LLM_CLIENT).toMatch(/from '@liftoffos\/shared-types'/);
    expect(LLM_CLIENT).toMatch(/params\.responseSchema\s*\?\s*\{\s*responseSchema:\s*params\.responseSchema\s*\}/);
    expect(LLM_CLIENT).toMatch(/params\.tenantId\s*\?\s*\{\s*tenantId:\s*params\.tenantId\s*\}/);
  });
  it('redacts the conversation before it reaches the model', () => {
    // A generated title is stored and shown in every thread list, so a
    // credential pasted into a first message would become a durable copy
    // nobody knows exists. Platform-backend has always redacted here; this
    // service had no redaction at all until @liftoffos/redact was shared.
    expect(THREAD_TITLE).toMatch(/redactSensitiveText\(params\.userMessage\)/);
    expect(THREAD_TITLE).toMatch(/redactSensitiveText\(params\.assistantMessage\)/);
    // From the shared package, not a local copy of the patterns.
    expect(THREAD_TITLE).toMatch(/from '@liftoffos\/redact'/);
  });

  it('the backfill over old threads runs the same adapter, not its own', () => {
    // A one-shot that titled rows its own way would drift from live turns and
    // could quietly skip redaction — the gap this service already had once.
    expect(BACKFILL).toMatch(/from '\.\.\/workforce-plans\/thread-title\.js'/);
    expect(BACKFILL).not.toMatch(/responseSchema/);
    expect(BACKFILL).not.toMatch(/systemPrompt/);
  });

  it('the shared redactor actually strips a credential', () => {
    // Proves the dependency resolves and works here, not just that the import
    // compiles.
    const dirty = 'my key is sk-ant-api03-' + 'A'.repeat(40) + ' keep this';
    const clean = redactSensitiveText(dirty);
    expect(clean).toContain('[REDACTED]');
    expect(clean).not.toContain('sk-ant-api03-A');
    expect(clean).toContain('keep this');
  });
});
