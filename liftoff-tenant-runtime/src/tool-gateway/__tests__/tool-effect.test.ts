import { classifyVendorToolEffect, effectPassesUngated } from '../tool-effect';

describe('classifyVendorToolEffect — precedence-ordered verb derivation', () => {
  it('read verbs classify as read', () => {
    for (const n of ['get_issue', 'list_repos', 'read_file', 'search_code', 'fetch_pr', 'describe_deployment', 'view_run', 'download_artifact', 'count_stars']) {
      expect(classifyVendorToolEffect(n)).toBe('read');
    }
  });

  it('mutating verbs classify as write', () => {
    for (const n of ['create_issue', 'delete_branch', 'merge_pull_request', 'update_file', 'send_email']) {
      expect(classifyVendorToolEffect(n)).toBe('write');
    }
  });

  it('mutating wins over read in mixed-verb names', () => {
    expect(classifyVendorToolEffect('list_and_delete_items')).toBe('write');
    expect(classifyVendorToolEffect('get_or_create_issue')).toBe('write');
  });

  it('unknown/exotic mutating verbs default to write (fail closed)', () => {
    for (const n of ['expire_token', 'sunset_policy', 'rotate_key']) {
      expect(classifyVendorToolEffect(n)).toBe('write');
    }
  });

  it('handles camelCase and dotted names', () => {
    expect(classifyVendorToolEffect('github.getIssue')).toBe('read');
    expect(classifyVendorToolEffect('github.createIssue')).toBe('write');
    expect(classifyVendorToolEffect('getOrCreateThread')).toBe('write');
  });

  it('a name with no recognized verb defaults to write', () => {
    expect(classifyVendorToolEffect('foobar')).toBe('write');
  });
});

describe('effectPassesUngated — missing effect gates', () => {
  it('only read passes ungated', () => {
    expect(effectPassesUngated('read')).toBe(true);
    expect(effectPassesUngated('write')).toBe(false);
    expect(effectPassesUngated('spawn')).toBe(false);
    expect(effectPassesUngated(undefined)).toBe(false);
  });
});
