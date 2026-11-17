// A vendor-hosted MCP server's tools arrive from the vendor at runtime, and
// discovery carries no provenance declarations. Without deriving the half that
// CAN be derived, every write through GitHub — the code-reviewer pilot's own
// connector — falls to the heuristic floor, which guesses. A floor bug is total
// when the floor is the only cover, which is what this week demonstrated.

import { deriveIdArgs, withDerivedDeclarations } from '../derive-declarations';

const schema = (props: string[], required: string[]) => ({
  type: 'object',
  properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])),
  required,
});

describe('deriveIdArgs', () => {
  it('finds a record id in the spellings vendors actually use', () => {
    // GitHub's own tools disagree with each other, so both must work.
    expect(deriveIdArgs(schema(['owner', 'repo', 'pull_number', 'issue_id'], ['issue_id'])))
      .toEqual(['issue_id']);
    expect(deriveIdArgs(schema(['documentId', 'text'], ['documentId'])))
      .toEqual(['documentId']);
    expect(deriveIdArgs(schema(['id', 'body'], ['id']))).toEqual(['id']);
  });

  it('reads REQUIRED arguments only', () => {
    // An optional id is a filter far more often than a target: assignee_id on
    // a search narrows a query and acts on nothing. Treating it as a record
    // makes every search look like an unprovenanced write.
    expect(deriveIdArgs(schema(['thread_id', 'assignee_id'], ['thread_id'])))
      .toEqual(['thread_id']);
  });

  it('ignores identifiers that name the REQUEST, not a record', () => {
    for (const noise of ['request_id', 'idempotency_key', 'trace_id', 'correlationId']) {
      expect(deriveIdArgs(schema([noise, 'body'], [noise, 'body']))).toBeUndefined();
    }
  });

  it('returns nothing rather than an empty list when there is no id', () => {
    // undefined means "no declaration"; [] would read as "declared none",
    // which is a different and wrong claim.
    expect(deriveIdArgs(schema(['title', 'body'], ['title']))).toBeUndefined();
  });

  it.each([
    ['no schema', undefined],
    ['null', null],
    ['no properties', { required: ['id'] }],
    ['no required list', { properties: { id: {} } }],
    ['empty required', { properties: { id: {} }, required: [] }],
  ])('returns nothing for %s', (_label, input) => {
    expect(deriveIdArgs(input)).toBeUndefined();
  });

  it('ignores a required name that is not actually a property', () => {
    expect(deriveIdArgs({ properties: { body: {} }, required: ['thread_id'] })).toBeUndefined();
  });
});

describe('deriveIdArgs with the tool name — the reviewed rule', () => {
  // The rule the generated declarations were reviewed against, applied to the
  // tools that never pass through the generator because they are discovered
  // at runtime. Named cases, so a change to the rule is a change to an
  // example rather than to a regex.
  it('keeps the argument about the noun the function acts on, and drops the rest', () => {
    expect(deriveIdArgs(schema(['task_id', 'assignee_id', 'title'], ['task_id', 'assignee_id']), 'update_task'))
      .toEqual(['task_id']);
    expect(deriveIdArgs(schema(['tag_id', 'task_id'], ['tag_id', 'task_id']), 'add_tag_to_task'))
      .toEqual(['tag_id', 'task_id']);
  });

  it('keeps the bare id on anything but a create', () => {
    expect(deriveIdArgs(schema(['id', 'body'], ['id']), 'update_page')).toEqual(['id']);
    expect(deriveIdArgs(schema(['id', 'name'], ['id', 'name']), 'create_project')).toBeUndefined();
  });

  it('on a create, keeps the parent and drops the chosen number for the created thing', () => {
    expect(deriveIdArgs(schema(['task_id', 'body'], ['task_id', 'body']), 'create_task_comment')).toEqual(['task_id']);
    expect(deriveIdArgs(schema(['customer_id', 'amount'], ['customer_id', 'amount']), 'create_customer_payment'))
      .toEqual(['customer_id']);
    // A scope the function does not name is not the target either way.
    expect(deriveIdArgs(schema(['invoice_number', 'customer_id'], ['invoice_number', 'customer_id']), 'create_invoice'))
      .toBeUndefined();
  });

  it('a number beside an id is an attribute, not a second identity', () => {
    expect(deriveIdArgs(schema(['invoice_id', 'invoice_number'], ['invoice_id', 'invoice_number']), 'update_invoice'))
      .toEqual(['invoice_id']);
    expect(deriveIdArgs(schema(['owner', 'repo', 'pullNumber'], ['owner', 'repo', 'pullNumber']), 'pull_request_review_write'))
      .toBeUndefined();
  });

  it('reads the bare name off an SDK-prefixed one', () => {
    expect(deriveIdArgs(schema(['page_id', 'title'], ['page_id']), 'mcp__notion-0badf00d__update_page'))
      .toEqual(['page_id']);
  });

  it('without a name, the shape test alone, as before', () => {
    expect(deriveIdArgs(schema(['task_id', 'assignee_id'], ['task_id', 'assignee_id'])))
      .toEqual(['task_id', 'assignee_id']);
  });
});

describe('withDerivedDeclarations', () => {
  it('fills idArgs on a discovered tool that has none', () => {
    const fn = withDerivedDeclarations({
      name: 'add_issue_comment',
      inputSchema: schema(['issue_id', 'body'], ['issue_id', 'body']),
    });
    expect(fn.idArgs).toEqual(['issue_id']);
  });

  it('NEVER overwrites a declaration somebody authored', () => {
    // A derivation that could replace a human's correction is one that stops
    // anybody correcting.
    const fn = withDerivedDeclarations({
      name: 'x',
      inputSchema: schema(['issue_id', 'other_id'], ['issue_id', 'other_id']),
      idArgs: ['other_id'],
    });
    expect(fn.idArgs).toEqual(['other_id']);
  });

  it('derives no returnsIds, because an input schema cannot say what a result holds', () => {
    // Guessing them would produce a declaration matching nothing, which reads
    // exactly like an uncovered tool while looking covered. Those are learned
    // from traffic by the shape observer instead.
    const fn = withDerivedDeclarations({
      name: 'list_issues',
      inputSchema: schema(['repo_id'], ['repo_id']),
    });
    expect(fn.returnsIds).toBeUndefined();
  });

  it('leaves a tool with no derivable id untouched', () => {
    const input = { name: 'search', inputSchema: schema(['query'], ['query']) };
    expect(withDerivedDeclarations(input)).toEqual(input);
  });
});

describe('the derivation covers every source a tool can arrive from', () => {
  // Three sources reach the runtime's schema cache: the connector catalog we
  // author, a vendor-hosted MCP server discovered at runtime, and a CUSTOM MCP
  // server a customer connects to their own workspace. The third cannot be
  // covered any other way — nobody here has seen its tools, so there is no
  // catalog entry to author and no migration to run. A derivation at the
  // boundary covers all three, and the connectors added next year too.

  const githubish = {
    name: 'add_issue_comment',
    inputSchema: {
      type: 'object',
      properties: { issue_id: { type: 'string' }, body: { type: 'string' } },
      required: ['issue_id', 'body'],
    },
  };

  it('covers a catalog tool the catalog forgot to declare', () => {
    expect(withDerivedDeclarations(githubish).idArgs).toEqual(['issue_id']);
  });

  it('covers a tool from a customer’s own MCP server', () => {
    // The case with no alternative: this schema was written by someone we have
    // never met, for a server we cannot enumerate.
    const custom = {
      name: 'update_ticket',
      inputSchema: {
        type: 'object',
        properties: { ticketId: { type: 'string' }, status: { type: 'string' } },
        required: ['ticketId', 'status'],
      },
    };
    expect(withDerivedDeclarations(custom).idArgs).toEqual(['ticketId']);
  });

  it('leaves an authored declaration alone whatever the source', () => {
    const authored = { ...githubish, idArgs: ['body'] };
    expect(withDerivedDeclarations(authored).idArgs).toEqual(['body']);
  });
});
