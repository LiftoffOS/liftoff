// The checker half of the eval harness — the half that must not cost money.
//
// Split out deliberately: a live run is expensive and non-deterministic, and
// the checking of it is neither. An eval suite whose expectations can only be
// re-checked by paying for another run is one people stop re-checking, and the
// expectations drift from what the cases were about.
//
// Every failure message is asserted to name what HAPPENED as well as what was
// expected. "expected create_review_comment" sends the reader back to the
// recording; "expected a call to create_review_comment; the run called
// get_diff" does not.

import { checkExpectation, effectiveToolCall, type CaseRecording } from '../template-eval-harness';

function rec(over: Partial<CaseRecording> = {}): CaseRecording {
  return {
    caseId: 'c',
    templateId: 't',
    recordedAt: '2026-09-06T00:00:00.000Z',
    finalText: 'Reviewed. No blocking issues.',
    toolNames: ['get_pull_request', 'create_review_comment'],
    skillLoads: [],
    outcome: 'success',
    ...over,
  };
}

describe('tool expectations', () => {
  it('passes when a required call happened', () => {
    expect(checkExpectation({ calls_tool: ['create_review_comment'] }, rec())).toEqual([]);
  });

  it('matches a namespaced tool by its bare name', () => {
    // The catalog namespaces tools per connector instance, so an expectation
    // written as the bare name has to match `github-d77db9a0__create_review_comment`
    // or every case would have to be rewritten whenever a binding changed.
    expect(checkExpectation(
      { calls_tool: ['create_review_comment'] },
      rec({ toolNames: ['github-d77db9a0__create_review_comment'] }),
    )).toEqual([]);
  });

  it('says what the run called instead', () => {
    const [msg] = checkExpectation({ calls_tool: ['post_summary'] }, rec());
    expect(msg).toContain('post_summary');
    expect(msg).toContain('create_review_comment');
  });

  it('fails a never_calls that was called', () => {
    const f = checkExpectation({ never_calls: ['create_review_comment'] }, rec());
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('expected NO call');
  });

  it('checks first_tool against the first call, not any call', () => {
    expect(checkExpectation({ first_tool: 'get_pull_request' }, rec())).toEqual([]);
    expect(checkExpectation({ first_tool: 'create_review_comment' }, rec())).toHaveLength(1);
  });

  it('does not accept a tool-count budget at all', () => {
    // `max_tool_calls` was removed from the vocabulary rather than left unused.
    // It measured model variance — 11 then 15 calls across two identical runs —
    // and part of the count is the SDK's own ToolSearch discovery, which the
    // agent does not choose. Leaving it in the schema would invite the next
    // author to reach for it.
    //
    // An unknown key asserts nothing rather than throwing, so this pins that
    // the checker ignores it instead of silently reviving the behaviour.
    expect(checkExpectation({ max_tool_calls: 1 } as never, rec())).toEqual([]);
  });

});

describe('reply expectations', () => {
  it('matches case-insensitively', () => {
    expect(checkExpectation({ reply_includes: ['NO BLOCKING'] }, rec())).toEqual([]);
  });

  it('fails an omission that was said', () => {
    const [msg] = checkExpectation({ reply_omits: ['no blocking issues'] }, rec());
    expect(msg).toContain('it said it');
  });

  it('passes an omission that was not said', () => {
    expect(checkExpectation({ reply_omits: ['needs a person to look'] }, rec())).toEqual([]);
  });
});

describe('no_skill_load', () => {
  it('fails when a skill was loaded, naming it', () => {
    const [msg] = checkExpectation({ no_skill_load: true }, rec({ skillLoads: ['read_skill'] }));
    expect(msg).toContain('read_skill');
  });

  it('passes when none was', () => {
    expect(checkExpectation({ no_skill_load: true }, rec())).toEqual([]);
  });
});

describe('an expectation asserts only what its case is about', () => {
  it('an empty expectation checks nothing', () => {
    // Legal here and rejected by the VALIDATOR, which is the right division:
    // the checker reports what a case asserts, and whether asserting nothing is
    // allowed is a question about the case, not about the run.
    expect(checkExpectation({}, rec())).toEqual([]);
  });

  it('does not fail a route it was not asked about', () => {
    // The rule this protects: when a live run takes an unexpected route and the
    // answer was right, WIDEN the acceptable set — never re-pin to the observed
    // route. A case about the reply must not start failing because the agent
    // reached the same answer a different way.
    expect(checkExpectation(
      { reply_includes: ['Reviewed'] },
      rec({ toolNames: ['search_code', 'get_pull_request', 'create_review_comment'] }),
    )).toEqual([]);
  });
});

describe('writes_include / writes_omit read what the agent WROTE', () => {
  // The escalation a code reviewer owes lives in the review body it posts, not
  // in the summary it hands back to whoever asked. One recorded run said "a
  // person needs to sign off" in its reply and "needs a person to look before
  // it merges" in the review it published, so a case reading the reply
  // measured paraphrase.
  const rec = {
    caseId: 'c', templateId: 't', recordedAt: '', finalText: 'A person needs to sign off.',
    toolNames: ['pull_request_review_write'],
    toolArgs: [{
      toolName: 'pull_request_review_write',
      args: { body: 'This change needs a person to look before it merges.' },
    }],
    skillLoads: [], outcome: 'success',
  };

  it('passes when the text is in a tool argument, though not in the reply', () => {
    expect(checkExpectation({ writes_include: ['needs a person to look'] }, rec)).toEqual([]);
  });

  it('fails when nothing written carries it', () => {
    expect(checkExpectation({ writes_include: ['no such phrase'] }, rec)).toHaveLength(1);
  });

  it('writes_omit fails when something written carries it', () => {
    expect(checkExpectation({ writes_omit: ['needs a person to look'] }, rec)).toHaveLength(1);
  });

  it('writes_omit passes for a run that wrote nothing at all', () => {
    const quiet = { ...rec, toolNames: [], toolArgs: [] };
    expect(checkExpectation({ writes_omit: ['needs a person to look'] }, quiet)).toEqual([]);
  });

  it('does not read the reply — that is what reply_includes is for', () => {
    // "sign off" is in finalText and in no argument.
    expect(checkExpectation({ writes_include: ['sign off'] }, rec)).toHaveLength(1);
  });
});

describe('last_delivery_never_calls', () => {
  const rec = (deliveries: string[][]) => ({
    caseId: 'c', templateId: 't', recordedAt: '', finalText: '',
    toolNames: deliveries.flat(), toolArgs: [], skillLoads: [], outcome: 'success',
    deliveries: deliveries.map((toolNames) => ({ toolNames, toolArgs: [], finalText: '', outcome: 'success' })),
  });

  it('passes when the action happened on the first delivery only', () => {
    // The shape of an idempotent redelivery, and the shape `never_calls`
    // cannot express: the first delivery MUST act or there is nothing to be
    // idempotent about.
    const f = checkExpectation(
      { last_delivery_never_calls: ['pull_request_review_write'] },
      rec([['pull_request_review_write'], ['have_i_acted_on']]),
    );
    expect(f).toEqual([]);
  });

  it('fails when the action repeated on the last delivery', () => {
    const f = checkExpectation(
      { last_delivery_never_calls: ['pull_request_review_write'] },
      rec([['pull_request_review_write'], ['pull_request_review_write']]),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('called it again');
  });

  it('reads a recording made before deliveries existed as one delivery', () => {
    // An older recording has no `deliveries`; treating it as a single delivery
    // holding everything keeps it replayable instead of silently passing.
    const legacy = {
      caseId: 'c', templateId: 't', recordedAt: '', finalText: '',
      toolNames: ['pull_request_review_write'], toolArgs: [], skillLoads: [], outcome: 'success',
    };
    const f = checkExpectation({ last_delivery_never_calls: ['pull_request_review_write'] }, legacy);
    expect(f).toHaveLength(1);
  });
});

describe('a deferred tool called through its search wrapper', () => {
  it('is recorded as the tool the agent used, with that tool\'s arguments', () => {
    // Codex and opencode reach connector tools over the HTTP MCP proxy, where
    // the tool sits behind `call_<alias>_tool`; the case names the tool.
    expect(effectiveToolCall({
      toolName: 'call_github_dd4c4689_tool',
      args: { name: 'github-dd4c4689__pull_request_review_write', args: { method: 'create', body: 'needs a person to look' } },
    })).toEqual({
      toolName: 'github-dd4c4689__pull_request_review_write',
      args: { method: 'create', body: 'needs a person to look' },
    });
  });

  it('leaves a direct call alone', () => {
    expect(effectiveToolCall({ toolName: 'mcp__github-dd4c4689__pull_request_read', args: { method: 'get' } }))
      .toEqual({ toolName: 'mcp__github-dd4c4689__pull_request_read', args: { method: 'get' } });
  });

  it('leaves a wrapper whose arguments name no tool alone', () => {
    expect(effectiveToolCall({ toolName: 'call_github_dd4c4689_tool', args: { query: 'x' } }))
      .toEqual({ toolName: 'call_github_dd4c4689_tool', args: { query: 'x' } });
  });
});

describe('writes_include_any', () => {
  const rec = (body: string): CaseRecording => ({
    caseId: 'c', templateId: 't', recordedAt: '', finalText: '', skillLoads: [], outcome: 'success',
    toolNames: ['pull_request_review_write'],
    toolArgs: [{ toolName: 'pull_request_review_write', args: { body } }],
  });

  it('passes on any one phrasing', () => {
    const expected = { writes_include_any: ['needs a person to look', 'person needs to look'] };
    expect(checkExpectation(expected, rec('A person needs to look before this merges.'))).toEqual([]);
    expect(checkExpectation(expected, rec('This needs a person to look before it merges.'))).toEqual([]);
  });

  it('fails when none is written, naming every phrasing', () => {
    const failures = checkExpectation({ writes_include_any: ['needs a person to look', 'person needs to look'] }, rec('Looks fine.'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"needs a person to look" / "person needs to look"');
  });
});
