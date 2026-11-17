// An admission denial must reach the model as a POLICY outcome.
//
// It used to be thrown as a bare `Error('Sandbox admission denied: …')`. By the
// time the tool-gateway MCP server had built the model-facing envelope, the
// message heuristic had classified it `internal_error` with the recovery text
// "An internal error occurred…", and the recovery LLM duly concluded
// "vendor/infrastructure outage or kill-switch". Nobody looked at the policy
// that actually fired. These tests pin every hop of that path.

import { AdmissionDeniedError, ADMISSION_DENIED_CODE, admissionDeniedRecovery } from '../../admission/types';
import { extractToolErrorContract } from '../tool-error-contract';
import { parseToolErrorEnvelope, formatToolErrorEnvelope } from '../tool-error-envelope';
import { classifyError, isRetryable, isToolErrorCode, TOOL_ERROR_CODES } from '@liftoffos/connector-types';

const DENIAL = new AdmissionDeniedError({
  reason: 'Tenant is suspended',
  quotaType: 'operational_status',
  message: 'Sandbox admission denied: Tenant is suspended',
});

describe('AdmissionDeniedError', () => {
  it('carries the reason and the gate that fired', () => {
    expect(DENIAL.reason).toBe('Tenant is suspended');
    expect(DENIAL.quotaType).toBe('operational_status');
    expect(DENIAL.code).toBe('admission_denied');
    expect(DENIAL).toBeInstanceOf(Error);
  });

  it('is exactly what the old bare Error was not: not classifiable as an outage', () => {
    // Same text, run through the heuristic that used to see it. This is the
    // defect, reproduced: prose alone classifies as internal_error.
    expect(classifyError({ message: DENIAL.message })).toBe('internal_error');
    // The type is what carries the truth past the heuristic.
    expect(extractToolErrorContract(DENIAL)?.code).toBe(ADMISSION_DENIED_CODE);
  });
});

describe('extractToolErrorContract', () => {
  it('returns the admission contract: code, not retryable, reason-first recovery', () => {
    const contract = extractToolErrorContract(DENIAL);

    expect(contract).toEqual({
      code: 'admission_denied',
      retryable: false,
      recovery: admissionDeniedRecovery('Tenant is suspended'),
      message: 'Sandbox admission denied: Tenant is suspended',
    });
    expect(contract?.recovery).toContain('Tenant is suspended');
    expect(contract?.recovery).toContain('not an outage');
    expect(contract?.code).not.toBe('internal_error');
  });
});

describe('the model-facing TOOL_ERROR envelope', () => {
  // Mirrors what mcp-server's buildToolErrorContent assembles from the
  // extracted contract; formatToolErrorEnvelope is its documented counterpart.
  function envelopeFor(err: AdmissionDeniedError): string {
    const c = extractToolErrorContract(err)!;
    return formatToolErrorEnvelope({
      message: c.message,
      code: c.code,
      retryable: c.retryable,
      recovery: c.recovery,
    });
  }

  it('states admission_denied with the reason, never internal_error', () => {
    const parsed = parseToolErrorEnvelope(envelopeFor(DENIAL));

    expect(parsed).not.toBeNull();
    expect(parsed!.code).toBe('admission_denied');
    expect(parsed!.retryable).toBe(false);
    expect(parsed!.error).toContain('Tenant is suspended');
    expect(parsed!.recovery).toContain('Tenant is suspended');
  });

  it('round-trips a kill-switch denial with its own reason', () => {
    const killSwitch = new AdmissionDeniedError({
      reason: 'Global freeze active: incident-4412',
      quotaType: 'global_freeze',
    });
    const parsed = parseToolErrorEnvelope(envelopeFor(killSwitch))!;

    expect(parsed.code).toBe('admission_denied');
    expect(parsed.recovery).toContain('incident-4412');
  });

  it('parses an admission envelope that carries no retryable/recovery fields', () => {
    // Absent retryable defaults to false straight from the taxonomy — a policy
    // gate gives the same answer to an identical call. Absent recovery falls
    // back to the taxonomy's generic policy wording, NOT to connector wording
    // and not to an echo of the message; a producer that knows the reason sends
    // the reason-first form explicitly (asserted above).
    const parsed = parseToolErrorEnvelope(
      `TOOL_ERROR ${JSON.stringify({ error: 'Tenant is suspended', code: 'admission_denied' })}`,
    )!;

    expect(parsed.code).toBe('admission_denied');
    expect(parsed.retryable).toBe(false);
    expect(parsed.error).toBe('Tenant is suspended');
    expect(parsed.recovery).toContain('policy');
    expect(parsed.recovery).not.toContain('internal error');
  });
});

describe('admission_denied is canonical, not bolted on', () => {
  // It is a real member of TOOL_ERROR_CODES in @liftoffos/connector-types
  // (0.12.0). Before that, the gateway carried a local union widening to
  // smuggle it through; these assertions are what let that shim be deleted.
  it('is in the shared taxonomy', () => {
    expect(TOOL_ERROR_CODES).toContain('admission_denied');
    expect(isToolErrorCode(ADMISSION_DENIED_CODE)).toBe(true);
  });

  it('is never retryable there, so the envelope default is already correct', () => {
    expect(isRetryable('admission_denied')).toBe(false);
    const parsed = parseToolErrorEnvelope(
      `TOOL_ERROR ${JSON.stringify({ error: 'Tenant is suspended', code: 'admission_denied' })}`,
    )!;
    expect(parsed.retryable).toBe(false);
  });

  it('falls back to policy wording, not connector wording, when no reason is sent', () => {
    const parsed = parseToolErrorEnvelope(
      `TOOL_ERROR ${JSON.stringify({ error: 'Tenant is suspended', code: 'admission_denied' })}`,
    )!;
    expect(parsed.recovery).toContain('policy');
    expect(parsed.recovery.toLowerCase()).toContain('same answer');
  });

  it('still rejects codes that are in neither set', () => {
    expect(parseToolErrorEnvelope(
      `TOOL_ERROR ${JSON.stringify({ error: 'x', code: 'made_up_code' })}`,
    )).toBeNull();
  });

  it('never lets the heuristic classifier invent the code', () => {
    // classifyError only sees vendor/transport signals. Nothing it can observe
    // implies a platform policy decision, so it must never guess this code.
    for (const message of ['admission denied', 'Sandbox admission denied: Tenant is suspended', 'boom']) {
      expect(classifyError({ message })).not.toBe('admission_denied');
    }
  });
});
