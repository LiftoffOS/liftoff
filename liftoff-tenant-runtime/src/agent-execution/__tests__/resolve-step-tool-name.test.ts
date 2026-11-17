// Resolve when unambiguous, refuse when not — the same rule bindings already
// follow, applied to workflow step tool names.
//
// Connector tools are named `<alias>__<fn>` and the alias is per-INSTANCE.
// Reconnecting mints a new alias and disables the old manifest — visible in the
// database as `google-sheets-2b820bc9` enabled beside `google-sheets-d14f7fd5`
// disabled. Bindings survive that through resolveCurrentId; step toolNames did
// not, and validateWorkflowGraph fails the WHOLE RUN on one stale name.
//
// The refusal half matters as much as the resolution half. With two accounts of
// one connector, picking either is how a run reads the wrong inbox.

import { resolveStepToolName } from '../resolve-step-tool-name';

const catalog = (...names: string[]): Set<string> => new Set(names);

describe('resolving a step tool name', () => {
  it('leaves a name the catalog already has alone', () => {
    const r = resolveStepToolName(
      'gitlab-1924102e__get_merge_request',
      catalog('gitlab-1924102e__get_merge_request'),
    );
    expect(r).toEqual({ kind: 'exact', toolName: 'gitlab-1924102e__get_merge_request' });
  });

  it('remaps a name whose connector was reconnected', () => {
    // The real shape: the step was written against the old instance, the
    // catalog now carries the new one, and exactly one survives.
    const r = resolveStepToolName(
      'google-mail-eaec0c30__list_messages',
      catalog('google-mail-0105297e__list_messages', 'slack-d77db9a0__send_message'),
    );
    expect(r).toEqual({
      kind: 'remapped',
      toolName: 'google-mail-0105297e__list_messages',
      from: 'google-mail-eaec0c30__list_messages',
    });
  });

  it('refuses to choose between two connected accounts', () => {
    // buildBindingsByType omits the type-keyed entry for exactly this reason:
    // "silently picking one would route tool calls to the wrong inbox".
    const r = resolveStepToolName(
      'google-mail-eaec0c30__list_messages',
      catalog('google-mail-0105297e__list_messages', 'google-mail-aaaa1111__list_messages'),
    );
    expect(r.kind).toBe('ambiguous');
    expect(r).toMatchObject({
      candidates: ['google-mail-0105297e__list_messages', 'google-mail-aaaa1111__list_messages'],
    });
  });

  it('does not remap across connector families', () => {
    // google_mail and google_sheets share a vendor prefix but are different
    // connectors; a mail step must never resolve to a sheets tool.
    const r = resolveStepToolName(
      'google-mail-eaec0c30__list_messages',
      catalog('google-sheets-2b820bc9__list_messages'),
    );
    expect(r.kind).toBe('unknown');
  });

  it('does not remap across functions', () => {
    // Same connector family, different verb. Resolving this would run an
    // operation the author never asked for — worse than failing.
    const r = resolveStepToolName(
      'google-mail-eaec0c30__list_messages',
      catalog('google-mail-0105297e__send_message'),
    );
    expect(r.kind).toBe('unknown');
  });

  it('reports unknown when the connector is simply gone', () => {
    const r = resolveStepToolName(
      'gitlab-1924102e__get_merge_request',
      catalog('slack-d77db9a0__send_message'),
    );
    expect(r.kind).toBe('unknown');
  });

  it('leaves a non-instance tool name alone rather than inventing a family', () => {
    // Standard tools like delegate_to_agent and per-agent slack_send_message
    // carry no instance suffix. There is no reconnect to undo.
    for (const name of ['delegate_to_agent', 'slack_send_message', 'web_research']) {
      expect(resolveStepToolName(name, catalog('something_else')).kind).toBe('unknown');
      expect(resolveStepToolName(name, catalog(name))).toEqual({ kind: 'exact', toolName: name });
    }
  });

  it('handles a function name that itself contains the separator', () => {
    // Splitting on the LAST separator would corrupt these.
    const r = resolveStepToolName(
      'gitlab-1924102e__notes__create',
      catalog('gitlab-aaaa1111__notes__create'),
    );
    expect(r).toMatchObject({ kind: 'remapped', toolName: 'gitlab-aaaa1111__notes__create' });
  });

  it('treats a malformed name as unknown rather than throwing', () => {
    for (const bad of ['', '__', 'alias__', '__fn']) {
      expect(() => resolveStepToolName(bad, catalog('x__y'))).not.toThrow();
      expect(resolveStepToolName(bad, catalog('x__y')).kind).toBe('unknown');
    }
  });
});
