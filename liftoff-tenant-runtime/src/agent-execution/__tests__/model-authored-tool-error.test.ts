// The line between "the model got the call wrong" and everything else.
//
// Getting this wrong in one direction wastes a recovery turn. Getting it wrong
// in the other puts a question in front of a person that they cannot answer —
// which is the defect this classifier exists to close. Every case
// below is written from that side: a false NEGATIVE is survivable, a false
// POSITIVE must not swallow a real failure that someone needs to hear about.

import {
  classifyModelAuthoredToolError,
  correctionForModelAuthoredToolError,
} from '../model-authored-tool-error';

describe('classifyModelAuthoredToolError', () => {
  // The exact MCP rejection string this guards against.
  it('matches the MCP input-validation rejection', () => {
    const actual =
      'MCP error -32602: Input validation error: Invalid arguments for tool search: [\n'
      + '  {\n    "expected": "string",\n    "code": "invalid_type",\n'
      + '    "path": [\n      "query"\n    ],\n'
      + '    "message": "Invalid input: expected string, received undefined"\n  }\n]';

    const result = classifyModelAuthoredToolError(actual);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('invalid_arguments');
    expect(result!.detail).toContain('query');
  });

  it.each([
    ['the JSON-RPC code alone', 'Server responded -32602'],
    ['the MCP SDK phrasing', 'Invalid arguments for tool create_issue'],
    ['the schema layer phrasing', 'Input validation error: title is required'],
    ['mixed case', 'INVALID ARGUMENTS FOR TOOL send_email'],
  ])('matches %s', (_label, text) => {
    expect(classifyModelAuthoredToolError(text)).not.toBeNull();
  });

  // Each of these describes a call that RAN. Someone may genuinely need to act
  // on them, so they must keep reaching the recovery path.
  it.each([
    ['an auth failure', '401 Unauthorized: token expired'],
    ['a permission refusal', 'Forbidden: the service account cannot read this sheet'],
    ['a missing resource', '404 Not Found: repository does not exist'],
    ['a rate limit', '429 Too Many Requests, retry after 30s'],
    ['a remote server fault', 'MCP error -32603: Internal error'],
    ['a plain bad request', '400 Bad Request'],
    ['a business rejection using the word invalid', 'The invoice was rejected: invalid billing address on file'],
    ['a timeout', 'Tool call timed out after 60000ms'],
  ])('does not match %s', (_label, text) => {
    expect(classifyModelAuthoredToolError(text)).toBeNull();
  });

  it('is not fooled by input that is not an error string', () => {
    expect(classifyModelAuthoredToolError(undefined)).toBeNull();
    expect(classifyModelAuthoredToolError(null)).toBeNull();
    expect(classifyModelAuthoredToolError('')).toBeNull();
    expect(classifyModelAuthoredToolError('   ')).toBeNull();
    expect(classifyModelAuthoredToolError({ code: -32602 })).toBeNull();
    expect(classifyModelAuthoredToolError(-32602)).toBeNull();
  });

  // -32602 is the code for Invalid params specifically. Its neighbours mean
  // other things and must not be swept up by a loose numeric match.
  it('does not match adjacent JSON-RPC codes', () => {
    expect(classifyModelAuthoredToolError('MCP error -32601: Method not found')).toBeNull();
    expect(classifyModelAuthoredToolError('MCP error -326021: nonsense')).toBeNull();
  });
});

describe('correctionForModelAuthoredToolError', () => {
  const err = { kind: 'invalid_arguments' as const, detail: 'query: expected string, received undefined' };

  it('carries the validation detail so the correction is actionable', () => {
    expect(correctionForModelAuthoredToolError('search', err)).toContain(
      'query: expected string, received undefined',
    );
  });

  it('names the tool that was called', () => {
    expect(correctionForModelAuthoredToolError('search', err)).toContain('"search"');
  });

  it('says the call never ran, so no side effect is assumed or reported', () => {
    const text = correctionForModelAuthoredToolError('search', err);
    expect(text).toMatch(/rejected before it ran/i);
    expect(text).toMatch(/nothing was executed/i);
  });

  // The whole point.
  it('forbids handing the argument back to the person', () => {
    expect(correctionForModelAuthoredToolError('search', err)).toMatch(
      /do not ask the person/i,
    );
  });

  it('still reads sensibly when the tool name is missing', () => {
    const text = correctionForModelAuthoredToolError(undefined, err);
    expect(text).toContain('that tool');
    expect(text).not.toContain('""');
  });
});

// The workflow path cannot short-circuit recovery the way the conversational
// path does, so it hands the advisor a contract instead. These pin the shape
// that both the steering and the veto key off.
describe('modelAuthoredToolErrorContract', () => {
  const { modelAuthoredToolErrorContract, MODEL_AUTHORED_TOOL_ERROR_CODE } =
    jest.requireActual('../model-authored-tool-error');

  it('builds a contract from a thrown Error', () => {
    const c = modelAuthoredToolErrorContract(
      new Error('MCP error -32602: Invalid arguments for tool search'),
      'search',
    );
    expect(c).toBeDefined();
    expect(c.code).toBe(MODEL_AUTHORED_TOOL_ERROR_CODE);
    expect(c.recovery).toContain('"search"');
    expect(c.recovery).toMatch(/do not ask the person/i);
  });

  it('builds one from a bare string too', () => {
    expect(modelAuthoredToolErrorContract('Input validation error: missing repo')).toBeDefined();
  });

  // Undefined is what keeps every other failure on its existing path — the
  // contract is the key the veto reads, so a false one would silence a real
  // escalation.
  it('returns undefined for a failure that is not the caller\'s to fix', () => {
    expect(modelAuthoredToolErrorContract(new Error('401 Unauthorized'))).toBeUndefined();
    expect(modelAuthoredToolErrorContract(new Error('MCP error -32603: Internal error'))).toBeUndefined();
    expect(modelAuthoredToolErrorContract(undefined)).toBeUndefined();
  });
});

// The workflow recovery path recorded only the anomaly KIND, so a run that
// recovered wrongly left nothing to diagnose. These pin the extractor that
// closes that gap.
describe('anomalyDetailText', () => {
  const { anomalyDetailText } = jest.requireActual('../model-authored-tool-error');

  it.each([
    ['tool_error', { kind: 'tool_error', error: 'MCP error -32602: bad args' }, 'MCP error -32602: bad args'],
    ['guardrail_blocked', { kind: 'guardrail_blocked', reason: 'blocked by policy' }, 'blocked by policy'],
    ['template_expansion', { kind: 'template_expansion', reference: '{{now.iso}}' }, '{{now.iso}}'],
    ['user_message_during_run', { kind: 'user_message_during_run', userMessage: 'stop' }, 'stop'],
    // The names it may not use are the detail: there is no sentence to read.
    ['recovery_proposal_rejected', { kind: 'recovery_proposal_rejected', rejected: ['gmail-bbb__send', 'crm__delete_record'] }, 'rejected: gmail-bbb__send, crm__delete_record'],
  ])('reads the detail off a %s anomaly', (_k, anomaly, expected) => {
    expect(anomalyDetailText(anomaly)).toBe(expected);
  });

  it('truncates a detail large enough to be a whole tool response', () => {
    const out = anomalyDetailText({ kind: 'tool_error', error: 'x'.repeat(5000) }, 100);
    expect(out).toHaveLength(101);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns undefined rather than throwing on shapes with no detail', () => {
    expect(anomalyDetailText({ kind: 'timeout', elapsedMs: 5 })).toBeUndefined();
    expect(anomalyDetailText(null)).toBeUndefined();
    expect(anomalyDetailText(undefined)).toBeUndefined();
    expect(anomalyDetailText('not an object')).toBeUndefined();
  });
});
