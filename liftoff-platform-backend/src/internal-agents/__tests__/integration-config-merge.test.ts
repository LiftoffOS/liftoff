// Unit tests for the server-side mergeDistillIntegrationConfigs.
//
// Semantics MUST stay aligned with the frontend mirror at
// liftoff-react/src/utils/mergeDistillIntegrationConfigs.ts. If you change
// behavior here, change it there too — drift means redistilled agents and
// freshly-created agents land on different persisted shapes.

import { mergeDistillIntegrationConfigs } from '../integration-config-merge';
import type { IntegrationPermission } from '../types';

const gmail = (overrides: Partial<IntegrationPermission> = {}): IntegrationPermission => ({
  id: 'inst-gmail',
  type: 'google_mail',
  integrationId: 'google_mail',
  selectedObjects: [],
  ...overrides,
});

const outlook = (overrides: Partial<IntegrationPermission> = {}): IntegrationPermission => ({
  id: 'inst-outlook',
  type: 'microsoft_outlook_mail',
  integrationId: 'microsoft_outlook_mail',
  selectedObjects: [],
  ...overrides,
});

const hubspot = (overrides: Partial<IntegrationPermission> = {}): IntegrationPermission => ({
  id: 'inst-hub',
  type: 'hubspot',
  integrationId: 'hubspot',
  selectedObjects: [],
  ...overrides,
});

describe('mergeDistillIntegrationConfigs', () => {
  it('returns current unchanged when integrationConfigs is undefined', () => {
    const current = [gmail()];
    const result = mergeDistillIntegrationConfigs(current, undefined);
    expect(result).toBe(current);
  });

  it('returns current unchanged when integrationConfigs is empty', () => {
    const current = [gmail()];
    const result = mergeDistillIntegrationConfigs(current, {});
    expect(result).toBe(current);
  });

  it('applies gmailQuery + sendAs onto a Gmail binding looked up by id', () => {
    const current = [gmail()];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-gmail': { gmailQuery: 'label:support', sendAs: 'help@x.com' },
    });
    expect(result[0].config).toEqual({ gmailQuery: 'label:support', sendAs: 'help@x.com' });
  });

  it('applies gmailQuery via integrationId fallback when id has no entry', () => {
    const current = [gmail()];
    const result = mergeDistillIntegrationConfigs(current, {
      google_mail: { gmailQuery: 'label:ops' },
    });
    expect(result[0].config).toEqual({ gmailQuery: 'label:ops' });
  });

  it('drops gmailQuery emitted against a non-Gmail integration', () => {
    const current = [hubspot()];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-hub': { gmailQuery: 'label:ops' },
    });
    expect(result[0].config).toBeUndefined();
  });

  it('drops outlookFilter emitted against a non-Outlook integration', () => {
    const current = [gmail()];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-gmail': { outlookFilter: "categories/any(c:c eq 'X')" },
    });
    expect(result[0].config).toBeUndefined();
  });

  it('drops sendAs emitted against an integration that is neither Gmail nor Outlook', () => {
    const current = [hubspot()];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-hub': { sendAs: 'help@x.com' },
    });
    expect(result[0].config).toBeUndefined();
  });

  it('preserves existing config keys the LLM did not re-emit', () => {
    const current = [gmail({ config: { gmailQuery: 'old', sendAs: 'old@x.com' } })];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-gmail': { gmailQuery: 'new' },
    });
    expect(result[0].config).toEqual({ gmailQuery: 'new', sendAs: 'old@x.com' });
  });

  it('treats empty-string emission as "leave existing alone"', () => {
    const current = [gmail({ config: { gmailQuery: 'existing' } })];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-gmail': { gmailQuery: '' },
    });
    expect(result).toBe(current);
  });

  it('applies outlookFilter onto an Outlook binding', () => {
    const current = [outlook()];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-outlook': { outlookFilter: "from/emailAddress/address eq 'x@y'" },
    });
    expect(result[0].config).toEqual({ outlookFilter: "from/emailAddress/address eq 'x@y'" });
  });

  it('returns same array reference when nothing changed', () => {
    const current = [gmail({ config: { gmailQuery: 'same' } })];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-gmail': { gmailQuery: 'same' },
    });
    expect(result).toBe(current);
  });

  // ── githubFilter ─────────────────────────────────────────────────────────
  // Added because the field was derived in distill-service and then dropped
  // here: every key this function does not name is silently discarded, so the
  // value reached the distill result and never reached the binding, and the
  // runtime kept applying its own default. A producer and this merge have to
  // land in the same change.

  const github = (overrides: Partial<IntegrationPermission> = {}): IntegrationPermission => ({
    id: 'inst-github',
    type: 'github',
    integrationId: 'github',
    selectedObjects: [],
    ...overrides,
  });

  it('applies githubFilter onto a GitHub binding', () => {
    const result = mergeDistillIntegrationConfigs([github()], {
      'inst-github': { githubFilter: { allowedActions: ['opened', 'synchronize'] } },
    });
    expect(result[0].config).toEqual({ githubFilter: { allowedActions: ['opened', 'synchronize'] } });
  });

  it('merges key-wise so an operator narrowing survives', () => {
    // repos/branches/authors are set on the connections page; allowedActions is
    // derived from the declared topics. Replacing the object would drop theirs.
    const current = [github({ config: { githubFilter: { repos: ['acme/web-app'], skipDrafts: true } } })];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-github': { githubFilter: { allowedActions: ['synchronize'] } },
    });
    expect(result[0].config).toEqual({
      githubFilter: { repos: ['acme/web-app'], skipDrafts: true, allowedActions: ['synchronize'] },
    });
  });

  it('drops githubFilter emitted for a non-GitHub binding', () => {
    const result = mergeDistillIntegrationConfigs([gmail()], {
      'inst-gmail': { githubFilter: { allowedActions: ['opened'] } },
    });
    expect(result[0].config ?? {}).toEqual({});
  });

  it('does not report a change when the derived filter is identical', () => {
    // Compared by value. `===` on a freshly-built object is always false, so
    // every redistill of a GitHub agent would show a binding diff that did not
    // happen — and a diff that always fires stops being read.
    const current = [github({ config: { githubFilter: { allowedActions: ['opened'] } } })];
    const result = mergeDistillIntegrationConfigs(current, {
      'inst-github': { githubFilter: { allowedActions: ['opened'] } },
    });
    expect(result).toBe(current);
  });
});
