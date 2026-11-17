// Unit tests for the canonical tool-error taxonomy (Phase 7 §8.1).
// Covers: classifyError (http status, message heuristics, connect gRPC codes),
// isRetryable ↔ code table parity, recoveryFor exhaustiveness, and toolError
// contract assembly.

import {
  TOOL_ERROR_CODES,
  type ToolErrorCode,
  isRetryable,
  isToolErrorCode,
  classifyError,
  recoveryFor,
  toolError,
} from '../tool-error';

describe('isRetryable', () => {
  // The single source of truth: only transient classes retry.
  const expected: Record<ToolErrorCode, boolean> = {
    auth_expired: false,
    permission_denied: false,
    not_found: false,
    invalid_arguments: false,
    rate_limited: true,
    vendor_unavailable: true,
    internal_error: false,
    admission_denied: false,
  };

  it.each(TOOL_ERROR_CODES)('matches the table for %s', (code) => {
    expect(isRetryable(code)).toBe(expected[code]);
  });
});

describe('admission_denied', () => {
  // A platform gate refusing the call before it reached any vendor. It belongs
  // in this taxonomy because the taxonomy answers "why did this tool call
  // fail", and left out of it, admission denials classified as internal_error
  // and the recovery LLM read a policy decision as an infrastructure outage.
  it('is a canonical code', () => {
    expect(isToolErrorCode('admission_denied')).toBe(true);
    expect(TOOL_ERROR_CODES).toContain('admission_denied');
  });

  it('is never retryable — a policy gate gives the same answer every time', () => {
    expect(isRetryable('admission_denied')).toBe(false);
    expect(toolError('admission_denied', 'Tenant is suspended').retryable).toBe(false);
  });

  it('is never produced by the heuristic classifier — it is only ever set explicitly', () => {
    // The classifier sees vendor/transport failures. Nothing it can observe
    // implies a platform policy decision, so it must never guess this code.
    const samples = [
      'admission denied', 'Sandbox admission denied: Tenant is suspended',
      'forbidden', '403', 'unauthorized', 'timeout', 'boom',
    ];
    for (const message of samples) {
      expect(classifyError({ message })).not.toBe('admission_denied');
    }
  });

  it('says policy, not connector, in its recovery text', () => {
    const text = recoveryFor('admission_denied', { connectorType: 'github' });
    expect(text).toContain('policy');
    expect(text).not.toContain('github');
    expect(text.toLowerCase()).toContain('same answer');
  });
});

describe('isToolErrorCode', () => {
  it('accepts every canonical code', () => {
    for (const code of TOOL_ERROR_CODES) expect(isToolErrorCode(code)).toBe(true);
  });
  it('rejects unknown strings and non-strings', () => {
    expect(isToolErrorCode('bogus')).toBe(false);
    expect(isToolErrorCode('')).toBe(false);
    expect(isToolErrorCode(undefined)).toBe(false);
    expect(isToolErrorCode(42)).toBe(false);
  });
});

describe('recoveryFor', () => {
  it('returns non-empty actionable text for every code', () => {
    for (const code of TOOL_ERROR_CODES) {
      const text = recoveryFor(code, { connectorType: 'github' });
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('names the connector when provided, else falls back to generic', () => {
    expect(recoveryFor('auth_expired', { connectorType: 'slack' })).toContain('the slack connector');
    expect(recoveryFor('auth_expired')).toContain('this connector');
  });

  // An agent that cannot tell WHICH integration failed will guess, and a
  // confident wrong guess is worse than an unexplained failure.
  //
  // Only auth_expired and permission_denied used to name it. A Composio 404
  // reads `Connected account "ca_…" not found` and classifies to
  // not_found, so the model saw an opaque id next to "The target does not
  // exist" — nothing said Slack. An agent reading that off a Slack send can
  // decide GitHub is broken and keep asking a human to reconnect a GitHub
  // account that does not exist.
  it('names the connector for EVERY code except admission_denied', () => {
    for (const code of TOOL_ERROR_CODES) {
      if (code === 'admission_denied') continue;
      expect(recoveryFor(code, { connectorType: 'slack' })).toContain('the slack connector');
    }
  });

  it('falls back to "this connector" for every code when type is absent', () => {
    // The fallback has to hold everywhere too, or a code with no context emits
    // a sentence with a hole in it.
    for (const code of TOOL_ERROR_CODES) {
      if (code === 'admission_denied') continue;
      expect(recoveryFor(code)).toContain('this connector');
    }
  });

  it('tells the model not to reattribute an id in a not_found message', () => {
    // The specific failure mode: the id in the vendor message belongs to the
    // connector that failed, and the agent guessed a different one.
    const text = recoveryFor('not_found', { connectorType: 'slack' });
    expect(text).toContain('do not attribute it to a different integration');
  });
});

describe('classifyError — http status', () => {
  const cases: Array<[number, ToolErrorCode]> = [
    [401, 'auth_expired'],
    [403, 'permission_denied'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [400, 'invalid_arguments'],
    [422, 'invalid_arguments'],
    [500, 'vendor_unavailable'],
    [503, 'vendor_unavailable'],
  ];
  it.each(cases)('status %s → %s', (httpStatus, code) => {
    expect(classifyError({ httpStatus })).toBe(code);
  });
});

describe('classifyError — message heuristics', () => {
  const cases: Array<[string, ToolErrorCode]> = [
    ['Invalid token, please reauth', 'auth_expired'],
    ['403 Forbidden: insufficient scope', 'permission_denied'],
    ['Resource not found', 'not_found'],
    ['Rate limit exceeded, too many requests', 'rate_limited'],
    ['Invalid argument: bad request', 'invalid_arguments'],
    ['Service unavailable, socket hang up', 'vendor_unavailable'],
    ['something totally unexpected', 'internal_error'],
  ];
  it.each(cases)('message "%s" → %s', (message, code) => {
    expect(classifyError({ message })).toBe(code);
  });

  it('defaults to internal_error with no signal', () => {
    expect(classifyError({})).toBe('internal_error');
  });
});

describe('classifyError — connect gRPC code is authoritative', () => {
  const cases: Array<[number, ToolErrorCode]> = [
    [9, 'auth_expired'],        // FailedPrecondition
    [7, 'permission_denied'],   // PermissionDenied
    [5, 'not_found'],           // NotFound
    [3, 'invalid_arguments'],   // InvalidArgument
    [14, 'vendor_unavailable'], // Unavailable
  ];
  it.each(cases)('connectCode %s → %s', (connectCode, code) => {
    expect(classifyError({ connectCode })).toBe(code);
  });

  it('unmapped connectCode falls through to message heuristics', () => {
    // Code.Internal (13) is unmapped → message heuristic classifies.
    expect(classifyError({ connectCode: 13, message: 'not found' })).toBe('not_found');
    expect(classifyError({ connectCode: 13, message: 'mystery' })).toBe('internal_error');
  });
});

describe('toolError', () => {
  it('derives retryable from code and carries recovery + message', () => {
    const c = toolError('rate_limited', 'slow down', { connectorType: 'github' }, 1500);
    expect(c.code).toBe('rate_limited');
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBe(1500);
    expect(c.message).toBe('slow down');
    expect(c.recovery.length).toBeGreaterThan(0);
  });

  it('permanent codes are non-retryable regardless of message', () => {
    const c = toolError('auth_expired', 'token expired');
    expect(c.retryable).toBe(false);
    expect(c.retryAfterMs).toBeUndefined();
  });
});

// An actionable vendor error must not be flattened into internal_error.
//
// internal_error is retryable:false, yet its recovery text used to say "retry
// once". So the agent repeated the identical call, failed identically, and
// abandoned the step — while the vendor's own message had already said exactly
// how to fix it.
//
// For example, a reviewing agent can reach the review-write step on a pull
// request and stop there on two of these:
//
//   Read: File content (28868 tokens) exceeds maximum allowed tokens (25000).
//         Use offset and limit parameters to read specific portions of the file
//   add_comment_to_pending_review: The line number doesn't exist in the pull
//         request diff / the side (LEFT/RIGHT) is invalid for the specified line
//
// Both are argument problems — the resource exists, the arguments do not fit
// it — and invalid_arguments carries the recovery that matches: "fix them per
// the tool schema and call again; do not repeat the same arguments."
describe('classifyError — actionable argument failures', () => {
  it('classifies an oversized read as invalid_arguments, not internal_error', () => {
    const msg = 'File content (28868 tokens) exceeds maximum allowed tokens (25000). '
      + 'Use offset and limit parameters to read specific portions of the file';
    expect(classifyError({ message: msg })).toBe('invalid_arguments');
  });

  it('classifies a diff position that is not in the diff', () => {
    const msg = "Failed to add comment to pending review. Possible reasons:\n"
      + "\t- The line number doesn't exist in the pull request diff\n"
      + "\t- The side (LEFT/RIGHT) is invalid for the specified line";
    expect(classifyError({ message: msg })).toBe('invalid_arguments');
  });

  it('does NOT steal a rate limit that happens to say "exceeded"', () => {
    // Ordering matters: "quota exceeded" is a rate limit and must stay one.
    expect(classifyError({ message: 'quota exceeded, slow down' })).toBe('rate_limited');
  });

  it('does NOT relabel a genuinely missing resource', () => {
    // The distinction is whether the TARGET is absent or the ARGUMENTS are
    // wrong. A missing repo is still not_found.
    expect(classifyError({ message: 'Repository does not exist' })).toBe('not_found');
    expect(classifyError({ message: '404 no such file' })).toBe('not_found');
  });

  it('leaves a real internal error alone', () => {
    expect(classifyError({ message: 'unexpected token in server response' })).toBe('internal_error');
  });
});

describe('recoveryFor(internal_error)', () => {
  it('does not promise a retry the contract marks non-retryable', () => {
    // RETRYABLE.internal_error is false. Prose that says "retry once" beside a
    // machine-readable retryable:false is a contract at odds with itself, and
    // the model reads the prose.
    const text = recoveryFor('internal_error', { connectorType: 'github' });
    expect(isRetryable('internal_error')).toBe(false);
    expect(text.toLowerCase()).not.toContain('retry once');
    expect(text).toContain('not expected to help');
  });
});
