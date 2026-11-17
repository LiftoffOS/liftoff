import { AUDIT_SOURCES, AuditSource, CursorPayload } from './types';

export function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof parsed?.occurredAt !== 'string') return null;
    if (typeof parsed?.rowId !== 'string') return null;
    if (!(AUDIT_SOURCES as readonly string[]).includes(parsed.source)) return null;
    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

// Re-export for test convenience.
export { AUDIT_SOURCES };
export type { AuditSource };
