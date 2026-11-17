// A placeholder is instruction syntax, never a value.
//
// `applyTemplate` resolves `{{…}}` for steps that declare a toolInputTemplate.
// An `llm_reason` step has no template — the MODEL writes the arguments, and it
// reads prompts full of placeholder syntax. It can copy one through.
//
// When it does, a call such as `mark_as_read` with
// `thread_id: "{{input.message.threadId}}"` passes schema validation because a
// placeholder is a non-empty string, reaches Gmail, and is recorded as a
// SUCCESS — unless something between the model and the vendor is looking.

import {
  findUnsubstitutedTemplates,
  assertNoUnsubstitutedTemplates,
  UnsubstitutedTemplateError,
} from '../unsubstituted-template-guard';

describe('finding unresolved placeholders', () => {
  it('catches a payload with unsubstituted placeholders', () => {
    const refs = findUnsubstitutedTemplates({
      user_id: '14a82d9e-269c-4d56-892a-7d3a9d259c0c',
      thread_id: '{{input.message.threadId}}',
    });
    expect(refs).toEqual([{ argPath: 'thread_id', value: '{{input.message.threadId}}' }]);
  });

  it('finds one nested inside an object or array', () => {
    // A placeholder in a message body reaches the vendor just as readily as a
    // top-level id, and is worse: it gets sent to a person.
    const refs = findUnsubstitutedTemplates({
      message: { body: 'Hi {{input.name}}, thanks for writing.' },
      cc: ['ops@example.test', '{{input.manager}}'],
    });
    expect(refs.map((r) => r.argPath).sort()).toEqual(['cc[1]', 'message.body']);
  });

  it('catches a placeholder embedded in surrounding prose', () => {
    expect(findUnsubstitutedTemplates({ q: 'from:{{input.from}} is:unread' })).toHaveLength(1);
  });

  it('leaves ordinary arguments alone', () => {
    for (const payload of [
      { thread_id: '18f2a3b4c5d6e7f8' },
      { body: 'We use {braces} and ${dollars} in prose.' },
      { code: 'const x = { y: 1 };' },
      { empty: '' },
      { n: 42, flag: true, nothing: null },
    ]) {
      expect(findUnsubstitutedTemplates(payload)).toEqual([]);
    }
  });

  it('does not fire on a lone brace pair with no variable inside', () => {
    // `{{}}` is not something the substituter resolves, and refusing it would
    // be the guard inventing a rule of its own.
    expect(findUnsubstitutedTemplates({ s: 'a {{}} b' })).toEqual([]);
  });
});

describe('the assertion', () => {
  it('throws with the offending paths, so recovery is told what to rewrite', () => {
    let err: UnsubstitutedTemplateError | undefined;
    try {
      assertNoUnsubstitutedTemplates('mark_as_read', { thread_id: '{{input.message.threadId}}' });
    } catch (e) {
      err = e as UnsubstitutedTemplateError;
    }
    expect(err).toBeInstanceOf(UnsubstitutedTemplateError);
    expect(err!.code).toBe('UNSUBSTITUTED_TEMPLATE');
    expect(err!.toolName).toBe('mark_as_read');
    expect(err!.refs).toHaveLength(1);
    expect(err!.message).toContain('thread_id');
  });

  it('is silent for a clean payload', () => {
    expect(() => assertNoUnsubstitutedTemplates('mark_as_read', { thread_id: 'abc' })).not.toThrow();
  });
});
