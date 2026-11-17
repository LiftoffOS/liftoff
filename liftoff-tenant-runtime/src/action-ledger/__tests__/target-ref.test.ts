// The action ledger has to know WHAT each action acted on, or it can answer
// nothing.
//
// Every write site derived the target the same way —
// `payload?.id || payload?.targetRef || ''` — and real tool payloads do not
// carry `id`, so almost no row had a usable target_ref and no write did.
//
// The cases below are ACTUAL payload shapes from real tool calls, not
// invented ones. A fixture that agrees with the code and disagrees with
// production proves nothing: fixtures that drift from the real catalog can
// hide something as bad as an unsatisfiable retry loop.
import {
  deriveTarget,
  connectorTypeFromAlias,
  isWriteAction,
  EMPTY_TARGET,
  actKeyFor,
  capabilityOperation,
  directOperation,
  equivalentActKeys,
  CAPABILITY_CONNECTOR,
} from '../target-ref';

describe('connectorTypeFromAlias', () => {
  // The `connector` column holds the tenant's connector INSTANCE alias. Keying
  // on it would make the same PR look like a different thing the moment a
  // reconnect mints a new connector id.
  it('strips the instance suffix from connector instance aliases', () => {
    expect(connectorTypeFromAlias('slack-d77db9a0')).toBe('slack');
    expect(connectorTypeFromAlias('google-mail-14a82d9e')).toBe('google-mail');
    expect(connectorTypeFromAlias('google-sheets-2b820bc9')).toBe('google-sheets');
    expect(connectorTypeFromAlias('github-7d07a896')).toBe('github');
  });

  it('leaves a bare type alone', () => {
    expect(connectorTypeFromAlias('github')).toBe('github');
    expect(connectorTypeFromAlias('slack')).toBe('slack');
  });

  it('normalizes the underscore spelling the conflict-policy registry uses', () => {
    expect(connectorTypeFromAlias('google_calendar')).toBe('google-calendar');
    expect(connectorTypeFromAlias('atlassian_jira')).toBe('atlassian-jira');
  });

  it('does not mistake a multi-word type for an instance suffix', () => {
    // `-14a82d9e` is 8 hex; `-mail` is not. Stripping greedily would collapse
    // google-mail and google-sheets onto `google`, which is what
    // splitLedgerAction's `.split('-')[0]` already does.
    expect(connectorTypeFromAlias('google-mail')).toBe('google-mail');
    expect(connectorTypeFromAlias('microsoft-outlook-mail')).toBe('microsoft-outlook-mail');
  });

  it('leaves runtime pseudo-connectors untouched', () => {
    expect(connectorTypeFromAlias('__builtin:search')).toBe('__builtin:search');
  });

  it('is not confused by empty input', () => {
    expect(connectorTypeFromAlias('')).toBe('');
    expect(connectorTypeFromAlias(undefined as unknown as string)).toBe('');
  });
});

describe('deriveTarget — the payloads that were recording nothing', () => {
  // A Slack send is `{channel, text}`, so every one recorded target_ref = ''.
  it('keys a Slack send on its channel', () => {
    expect(deriveTarget({
      connector: 'slack-d77db9a0',
      actionType: 'send_message',
      payload: { channel: 'C0123456789', text: 'Review ready' },
    })).toEqual({ ref: 'slack:C0123456789', version: null, basis: 'connector_rule' });
  });

  it('keys a threaded reply on the thread, not the channel', () => {
    // "Have I already replied in this thread" is answerable; keying on the
    // channel alone would make every reply look like the same action.
    expect(deriveTarget({
      connector: 'slack-d77db9a0',
      actionType: 'send_message',
      payload: { channel: 'C0123456789', thread_ts: '1756000000.123456', text: 'hi' },
    }).ref).toBe('slack:C0123456789/1756000000.123456');
  });

  it('keys a Gmail thread read on the thread', () => {
    expect(deriveTarget({
      connector: 'google-mail-14a82d9e',
      actionType: 'get_thread',
      payload: { thread_id: 'a239502b68ecd7f7' },
    }).ref).toBe('google-mail:thread/a239502b68ecd7f7');
  });

  it('reads a bare id as a thread on a thread verb and a message otherwise', () => {
    // Prod carried both `get_thread {id}` and `mark_as_read {id}`.
    expect(deriveTarget({
      connector: 'google-mail-14a82d9e', actionType: 'read_thread', payload: { id: 'abc' },
    }).ref).toBe('google-mail:thread/abc');
    expect(deriveTarget({
      connector: 'google-mail-14a82d9e', actionType: 'mark_as_read', payload: { id: 'abc' },
    }).ref).toBe('google-mail:message/abc');
  });

  it('keys a new email on its recipients and subject, so a repeat send is the same target', () => {
    const first = deriveTarget({
      connector: 'google-mail-0105297e', actionType: 'send_email',
      payload: { to: 'person@example.com', subject: 'Lead enrichment result', body: 'v1' },
    });
    const recomposed = deriveTarget({
      connector: 'google-mail-0105297e', actionType: 'send_email',
      payload: { to: 'person@example.com', subject: 'Lead enrichment result', body: 'v2, reworded' },
    });
    expect(first.ref).toMatch(/^google-mail:to\/person@example.com@[0-9a-f]{12}$/);
    expect(first.basis).toBe('connector_rule');
    // Same person, same subject, different wording: the same act.
    expect(recomposed.ref).toBe(first.ref);
  });

  it('tells two emails to the same person apart by subject, and the same people apart from others', () => {
    const base = { connector: 'google-mail-0105297e', actionType: 'send_email' };
    const a = deriveTarget({ ...base, payload: { to: 'a@x.com', subject: 'Invoice', body: '' } }).ref;
    const b = deriveTarget({ ...base, payload: { to: 'a@x.com', subject: 'Welcome', body: '' } }).ref;
    const c = deriveTarget({ ...base, payload: { to: 'b@x.com', subject: 'Invoice', body: '' } }).ref;
    expect(new Set([a, b, c]).size).toBe(3);
    // Recipient order and case do not make a different target.
    const ab = deriveTarget({ ...base, payload: { to: 'A@x.com, b@x.com', subject: 'Invoice', body: '' } }).ref;
    const ba = deriveTarget({ ...base, payload: { to: 'b@x.com,a@x.com', subject: 'Invoice', body: '' } }).ref;
    expect(ab).toBe(ba);
  });

  it('reads the recipient under the vendor\'s own field names, and as an array', () => {
    const base = { connector: 'google-mail-0105297e', actionType: 'send_email' };
    const canonical = deriveTarget({ ...base, payload: { to: 'person@example.com', subject: 'Lead enrichment result', body: '' } }).ref;
    // The Gmail schema the model sees names the recipient `recipient_email`
    // and adds `user_id: 'me'`; the dispatcher accepts it, so the ledger must.
    const vendor = deriveTarget({ ...base, payload: { recipient_email: 'person@example.com', subject: 'Lead enrichment result', body: '', user_id: 'me' } }).ref;
    expect(vendor).toBe(canonical);
    const outlook = deriveTarget({
      connector: 'microsoft-outlook-mail-1234abcd', actionType: 'send_email',
      payload: { to_recipients: ['b@x.com', 'A@x.com'], subject: 'Invoice', body: '' },
    }).ref;
    expect(outlook).toMatch(/^microsoft-outlook-mail:to\/a@x\.com,b@x\.com@[0-9a-f]{12}$/);
    const typed = deriveTarget({
      connector: 'microsoft-outlook-mail-1234abcd', actionType: 'send_email',
      payload: { toRecipients: [{ emailAddress: { address: 'a@x.com' } }], subject: 'Invoice', body: '' },
    }).ref;
    // A nested vendor object the rule does not understand yields no target
    // rather than a guessed one.
    expect(typed).toBe('');
  });

  it('keys a threaded send on the thread, not on the recipients', () => {
    expect(deriveTarget({
      connector: 'google-mail-0105297e', actionType: 'send_email',
      payload: { to: 'a@x.com', subject: 'Re: hi', body: '', threadId: 'a239502b68ecd7f7' },
    }).ref).toBe('google-mail:thread/a239502b68ecd7f7');
  });

  it('gives an Outlook send the same recipient-and-subject identity', () => {
    expect(deriveTarget({
      connector: 'microsoft-outlook-mail-1234abcd', actionType: 'send_email',
      payload: { to: 'a@x.com', subject: 'Invoice', body: '' },
    }).ref).toMatch(/^microsoft-outlook-mail:to\/a@x\.com@[0-9a-f]{12}$/);
  });

  it('ignores user_id, which names the connected account and not the target', () => {
    // Real payload: mark_as_read {remove_label_ids, thread_id, user_id}. Keying
    // on user_id would collapse every Gmail action in the tenant onto one key.
    const target = deriveTarget({
      connector: 'google-mail-14a82d9e',
      actionType: 'mark_as_read',
      payload: { remove_label_ids: ['UNREAD'], thread_id: '1a013be101761dc2', user_id: 'me' },
    });
    expect(target.ref).toBe('google-mail:thread/1a013be101761dc2');
  });

  it('keys a Sheets call on the spreadsheet', () => {
    expect(deriveTarget({
      connector: 'google-sheets-2b820bc9',
      actionType: 'query_table',
      payload: { spreadsheet_id: '1AbCd' },
    }).ref).toBe('google-sheets:1AbCd');
  });
});

describe('deriveTarget — GitHub, the case the whole design started from', () => {
  it('keys a review on owner/repo#number', () => {
    expect(deriveTarget({
      connector: 'github',
      actionType: 'create_review',
      payload: { owner: 'acme', repo: 'billing', pull_number: 17, body: '...' },
    })).toEqual({
      ref: 'github:acme/billing#17',
      version: null,
      basis: 'connector_rule',
    });
  });

  it('takes a numeric pull_number — numbers are identifiers too', () => {
    // `pick` accepting only strings would have dropped every GitHub target,
    // since pull_number arrives as a number.
    expect(deriveTarget({
      connector: 'github', actionType: 'create_review',
      payload: { owner: 'a', repo: 'b', pull_number: 17 },
    }).ref).toBe('github:a/b#17');
  });

  it('reads a sha as the VERSION of a numbered thing', () => {
    const target = deriveTarget({
      connector: 'github',
      actionType: 'create_review',
      payload: { owner: 'acme', repo: 'billing', pull_number: 17, commit_id: 'a450b99' },
    });
    expect(target.ref).toBe('github:acme/billing#17');
    expect(target.version).toBe('a450b99');
  });

  it('reads a sha as the IDENTITY of a bare commit', () => {
    // Same field, opposite meaning. Reading it one way in both places would
    // give "reviewed PR #17" and "looked at commit abc" the same key.
    const target = deriveTarget({
      connector: 'github', actionType: 'get_commit',
      payload: { owner: 'acme', repo: 'billing', sha: 'a450b99' },
    });
    expect(target.ref).toBe('github:acme/billing@a450b99');
    expect(target.version).toBeNull();
  });

  it('accepts the full_name spelling', () => {
    expect(deriveTarget({
      connector: 'github', actionType: 'create_issue_comment',
      payload: { full_name: 'acme/billing', issue_number: 7 },
    }).ref).toBe('github:acme/billing#7');
  });

  it('gives a code search no target — a query is not an entity', () => {
    // `github search {query}` is a common shape. Inventing a target would make
    // every distinct search look like the same repeated action.
    expect(deriveTarget({
      connector: 'github', actionType: 'search', payload: { query: 'repo:x is:open' },
    })).toEqual(EMPTY_TARGET);
  });
});

describe('deriveTarget — never invents a value', () => {
  // A row can hold the literal string "null" in target_ref: String(null)
  // from `String(payload?.id ?? payload?.targetRef ?? '')`, where an `id` key
  // present but explicitly null defeats `??`. "null" reads as a value to
  // everything downstream.
  it('returns empty for an explicitly null id rather than the string "null"', () => {
    const target = deriveTarget({
      connector: 'google-mail-14a82d9e', actionType: 'get_thread', payload: { id: null },
    });
    expect(target).toEqual(EMPTY_TARGET);
    expect(target.ref).not.toBe('null');
  });

  it('returns empty for undefined, empty-string and object-valued ids', () => {
    for (const id of [undefined, '', '   ', {}, []] as unknown[]) {
      expect(deriveTarget({ connector: 'slack', actionType: 'x', payload: { id } }).ref).toBe('');
    }
  });

  it('returns empty for a missing payload entirely', () => {
    expect(deriveTarget({ connector: 'slack', actionType: 'list_channels' })).toEqual(EMPTY_TARGET);
    expect(deriveTarget({ connector: 'slack', actionType: 'x', payload: null })).toEqual(EMPTY_TARGET);
  });

  it('gives runtime pseudo-connectors no target', () => {
    expect(deriveTarget({
      connector: '__builtin:search', actionType: 'search', payload: { query: 'x', id: 'z' },
    })).toEqual(EMPTY_TARGET);
  });
});

describe('deriveTarget — the long tail', () => {
  // There are far more connector toolkits than there will ever be hand-written
  // rules, so the generic scan is what most Composio tools land on.
  it('finds a domain id no rule anticipated', () => {
    const target = deriveTarget({
      connector: 'freshdesk-1a2b3c4d', actionType: 'update_ticket',
      payload: { ticket_id: '9912', status: 'closed' },
    });
    expect(target).toEqual({ ref: 'freshdesk:ticket/9912', version: null, basis: 'generic_id' });
  });

  it('refuses caller identifiers even when they are the only ids present', () => {
    expect(deriveTarget({
      connector: 'someapp-1a2b3c4d', actionType: 'send',
      payload: { user_id: 'u1', connection_id: 'c1', trace_id: 't1' },
    })).toEqual(EMPTY_TARGET);
  });

  it('prefers a plain id over a scanned one, deterministically', () => {
    expect(deriveTarget({
      connector: 'someapp', actionType: 'update', payload: { id: 'X1', zzz_id: 'Y2' },
    }).ref).toBe('someapp:X1');
  });

  it('picks the same key every time when several domain ids are present', () => {
    const payload = { beta_id: 'B', alpha_id: 'A' };
    const first = deriveTarget({ connector: 'someapp', actionType: 'update', payload });
    const second = deriveTarget({ connector: 'someapp', actionType: 'update', payload });
    expect(first.ref).toBe(second.ref);
    expect(first.ref).toBe('someapp:alpha/A');
  });
});

describe('deriveTarget — fits the column without merging distinct targets', () => {
  // actions.target_ref is VARCHAR(255). A plain slice would make two different
  // long targets collide, and a dedup key that merges distinct things is the
  // one failure mode worse than having no key.
  it('keeps over-long refs within 255 characters', () => {
    const ref = deriveTarget({
      connector: 'notion', actionType: 'update_page', payload: { page_id: 'p'.repeat(400) },
    }).ref;
    expect(ref.length).toBeLessThanOrEqual(255);
  });

  it('keeps two over-long refs distinct despite a shared prefix', () => {
    const a = deriveTarget({
      connector: 'notion', actionType: 'u', payload: { page_id: 'p'.repeat(400) + 'A' },
    }).ref;
    const b = deriveTarget({
      connector: 'notion', actionType: 'u', payload: { page_id: 'p'.repeat(400) + 'B' },
    }).ref;
    expect(a).not.toBe(b);
  });
});

describe('the act key — one identity for the same outward act, whichever way it went', () => {
  const email = { to: 'person@example.com', subject: 'Lead enrichment result', body: 'x' };

  it('a capability names no vendor, so its target comes from the arguments alone', () => {
    const t = deriveTarget({ connector: CAPABILITY_CONNECTOR, actionType: 'run_capability', payload: email });
    expect(t.ref).toMatch(/^capability:to\/person@example.com@[0-9a-f]{12}$/);
    expect(t.basis).toBe('connector_rule');
    const chat = deriveTarget({ connector: CAPABILITY_CONNECTOR, actionType: 'run_capability', payload: { channel: 'C1', text: 'hi' } });
    expect(chat.ref).toBe('capability:C1');
    const threaded = deriveTarget({ connector: CAPABILITY_CONNECTOR, actionType: 'run_capability', payload: { channel: 'C1', thread_ts: '1.2' } });
    expect(threaded.ref).toBe('capability:C1/1.2');
    // Not mail- or chat-shaped: no target, no guess.
    expect(deriveTarget({ connector: CAPABILITY_CONNECTOR, actionType: 'run_capability', payload: { query: 'q' } }).ref).toBe('');
  });

  it('shares the path half between a direct send and a capability of the same email', () => {
    const direct = deriveTarget({ connector: 'google-mail-0105297e', actionType: 'send_email', payload: email });
    const viaCap = deriveTarget({ connector: CAPABILITY_CONNECTOR, actionType: 'run_capability', payload: email });
    const directKey = actKeyFor(directOperation('google-mail-0105297e', 'send_email'), direct)!;
    const capKey = actKeyFor(capabilityOperation('0123456789ab', 'mail_send'), viaCap)!;
    expect(directKey.startsWith('google-mail:send_email|')).toBe(true);
    expect(capKey.startsWith('cap:mail_send:0123456789ab|')).toBe(true);
    expect(directKey.split('|')[1]).toBe(capKey.split('|')[1]);
    // A capability with no family is keyed on its operation alone.
    expect(actKeyFor(capabilityOperation('0123456789ab'), viaCap)!.startsWith('cap:0123456789ab|')).toBe(true);
  });

  it('keeps two capabilities with the same arguments apart by operation', () => {
    const t = deriveTarget({ connector: CAPABILITY_CONNECTOR, actionType: 'run_capability', payload: email });
    expect(actKeyFor(capabilityOperation('aaaaaaaaaaaa'), t)).not.toBe(actKeyFor(capabilityOperation('bbbbbbbbbbbb'), t));
  });

  it('has no key when the target has no path', () => {
    expect(actKeyFor('google-mail:send_email', { ref: '', version: null, basis: 'none' })).toBeNull();
  });

  it('a mail send is equivalent to the curated direct sends and to the mail_send capabilities on the path', () => {
    const path = 'to/a@x.com@0123456789ab';
    const eq = equivalentActKeys(`cap:mail_send:0123456789ab|${path}`);
    expect(eq.exact).toEqual(expect.arrayContaining([
      `cap:mail_send:0123456789ab|${path}`, `google-mail:send_email|${path}`, `microsoft-outlook-mail:send_email|${path}`,
      `sendgrid:send_email|${path}`,
    ]));
    expect(eq.capabilityLike).toBe(`cap:mail_send:%|${path}`);
    const fromDirect = equivalentActKeys(`google-mail:send_email|${path}`);
    expect(fromDirect.capabilityLike).toBe(`cap:mail_send:%|${path}`);
  });

  it('a capability outside the family matches only itself, however mail-shaped its arguments', () => {
    const path = 'to/a@x.com@0123456789ab';
    // Same recipient and subject, but the handle named no family: a different
    // kind of act, or one the control plane has not classified. Not a send.
    expect(equivalentActKeys(`cap:0123456789ab|${path}`)).toEqual({
      exact: [`cap:0123456789ab|${path}`], capabilityLike: null,
    });
    expect(equivalentActKeys(`cap:calendar_invite:0123456789ab|${path}`)).toEqual({
      exact: [`cap:calendar_invite:0123456789ab|${path}`], capabilityLike: null,
    });
  });

  it('a draft on the same path is its own act, and a non-mail path has no equivalents', () => {
    const path = 'to/a@x.com@0123456789ab';
    expect(equivalentActKeys(`google-mail:create_draft|${path}`)).toEqual({
      exact: [`google-mail:create_draft|${path}`], capabilityLike: null,
    });
    expect(equivalentActKeys('github:add_comment|acme/web-app#42')).toEqual({
      exact: ['github:add_comment|acme/web-app#42'], capabilityLike: null,
    });
  });

  it('escapes LIKE metacharacters in the path', () => {
    const eq = equivalentActKeys('cap:mail_send:0123456789ab|to/a_b@x.com@0123456789ab');
    expect(eq.capabilityLike).toBe('cap:mail_send:%|to/a\\_b@x.com@0123456789ab');
  });
});

describe('isWriteAction', () => {
  // Only used to decide whether a missing target deserves a log line. An
  // unkeyed read is unremarkable; an unkeyed write is a rule that needs writing.
  it('recognises the writes that were recording nothing', () => {
    for (const verb of ['send_message', 'create_review', 'mark_as_read', 'update_ticket',
      'post_comment', 'delete_message', 'createReview']) {
      expect(isWriteAction(verb)).toBe(true);
    }
  });

  it('does not flag reads', () => {
    for (const verb of ['search', 'list_channels', 'get_thread', 'read_message',
      'query_table', 'get_sheet_names']) {
      expect(isWriteAction(verb)).toBe(false);
    }
  });
});

// ── A GitHub review's commit_id moves; original_commit_id does not ──────────
//
// `commit_id` on a review or a review comment is RESOLVED AT READ TIME. It
// answers "where does this land on the branch as it stands now", which is what
// GitHub needs to render a comment against the current diff, and it follows
// every push. `original_commit_id` is pinned to what was being looked at when
// the comment was written.
//
// Reviews submitted while one commit was the only commit on the branch, read
// back after further pushes, report the head as commit_id on every inline
// comment while original_commit_id still names the reviewed commit. The
// reviews themselves can split — COMMENTED ones still reading the original
// commit, APPROVED ones moved to the head — so sampling the COMMENTED ones
// alone makes commit_id look like stable provenance.
//
// target_version is the dedupe discriminator (findCompletedDuplicate matches on
// target_ref + target_version), so keying it on a moving value lets two runs
// against the SAME code record different versions, the guard stops matching,
// and duplicate reviews return.

describe('a pinned commit beats a read-time-resolved one', () => {
  const call = (payload: Record<string, unknown>) => deriveTarget({
    connector: 'github-dd4c4689',
    actionType: 'pull_request_review_write',
    payload,
  });

  it('prefers original_commit_id when a payload carries both', () => {
    const t = call({
      owner: 'acme',
      repo: 'webapp',
      pullNumber: 42,
      commit_id: 'da1b599',          // the head as it stands NOW
      original_commit_id: '77773b0', // what was actually reviewed
    });
    expect(t.version).toBe('77773b0');
  });

  it('still uses commit_id when it is the only sha offered', () => {
    // Most write payloads carry no original_commit_id — it is a field GitHub
    // returns on reads. Nothing regresses for them.
    const t = call({
      owner: 'acme', repo: 'webapp', pullNumber: 42, commit_id: 'da1b599',
    });
    expect(t.version).toBe('da1b599');
  });

  it('keeps the same target_ref either way, so the pair still dedupes', () => {
    const withPinned = call({
      owner: 'acme', repo: 'webapp', pullNumber: 42,
      commit_id: 'da1b599', original_commit_id: '77773b0',
    });
    const withMoving = call({
      owner: 'acme', repo: 'webapp', pullNumber: 42, commit_id: 'da1b599',
    });
    expect(withPinned.ref).toBe(withMoving.ref);
  });
});
