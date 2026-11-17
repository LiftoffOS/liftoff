// The catalog PB reads and the catalog the runtime executes must name tools
// identically.
//
// Two sanitizers build aliased tool names in this repo, and both are reached:
// `sanitizeAlias` in the tool-catalog service, which is what the control plane
// sees over RPC when it distills; and `sanitizeToolNameSegment`, which every
// runtime assembly site uses. The control plane keys `toolDescriptionOverrides`
// and `groundsOn` on the names IT was given, and the runtime looks them up by
// the names IT builds.
//
// If those disagree by one character, every override and every grounding rule
// silently matches nothing. Nothing throws: a Map lookup returns undefined, the
// tool keeps its vendor description, and the feature is simply absent — which
// reads in a diff exactly like a feature that works.
//
// That is not hypothetical. A gate that resolves the catalog through the action
// ledger's hyphen-normalised namespace gets nothing back for every
// underscore-typed connector and never fires, while slack and github keep
// working because they have no underscore to mangle. This test exists so that
// mistake cannot be made in this repo.

import { sanitizeAlias } from '../catalog-service';
import { sanitizeToolNameSegment } from '../../agent-execution/tool-name-sanitizer';

describe('the two alias sanitizers agree', () => {
  it.each([
    ['google-mail-0105297e'],   // the live dev alias: hyphens throughout
    ['google_mail-0105297e'],   // underscore type, hyphen instance suffix
    ['slack-d77db9a0'],
    ['github'],
    ['custom_mcp_server-1234abcd'],
    ['atlassian_jira'],
    ['Weird Alias With Spaces'],
    ['dots.and.more.dots'],
    ['emoji-🙂-alias'],
  ])('%s', (alias) => {
    expect(sanitizeAlias(alias)).toBe(sanitizeToolNameSegment(alias));
  });

  it('preserves BOTH hyphen and underscore', () => {
    // The whole point. A sanitizer that normalised one into the other would
    // put the control plane and the runtime in different key spaces while
    // every individual name still looked reasonable.
    expect(sanitizeAlias('google_mail-0105297e')).toBe('google_mail-0105297e');
    expect(sanitizeToolNameSegment('google_mail-0105297e')).toBe('google_mail-0105297e');
  });

  it('produces the exact names the control plane emits', () => {
    // Recorded from a live distill: these are the keys the control
    // plane put in toolDescriptionOverrides and groundsOn for a gmail-bound
    // hire. The runtime must build the same strings or both features miss.
    const alias = 'google-mail-0105297e';
    expect(`${sanitizeToolNameSegment(alias)}__list_messages`)
      .toBe('google-mail-0105297e__list_messages');
    expect(`${sanitizeToolNameSegment(alias)}__reply_to_thread`)
      .toBe('google-mail-0105297e__reply_to_thread');
  });
});
