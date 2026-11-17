// Sandbox Output Sanitizer
// Scans sandbox stdout/stderr for secrets before returning output to the LLM.

import { createHash } from 'crypto';

// Common secret patterns (API keys, tokens, credentials)
const SECRET_PATTERNS: RegExp[] = [
  // AWS keys
  /AKIA[0-9A-Z]{16}/g,
  /(?:aws_secret_access_key|aws_session_token)\s*[:=]\s*\S+/gi,
  // GCP service account keys / tokens
  /ya29\.[0-9A-Za-z_-]+/g,
  // GitHub PATs
  /gh[pousr]_[A-Za-z0-9_]{36,255}/g,
  /github_pat_[A-Za-z0-9_]{22,255}/g,
  // Generic API keys (long hex/base64 strings after key identifiers)
  /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_/+=-]{20,}["']?/gi,
  // JWTs (three base64url segments separated by dots)
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Connection strings with passwords
  /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s]+/gi,
  // Slack tokens
  /xox[baprs]-[0-9A-Za-z-]+/g,
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI API keys
  /sk-[A-Za-z0-9]{20,}/g,
  // Private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
];

// ANSI escape sequence pattern
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const REDACTED = '[REDACTED]';

// Max binary base64 field size before truncation (browser screenshots etc.)
const MAX_BINARY_FIELD_BYTES = 5 * 1024 * 1024;

export class SandboxOutputSanitizer {
  private readonly maxOutputBytes: number;
  private readonly injectedCredentialValues: Set<string>;
  private readonly logger?: { info: (msg: Record<string, unknown>) => void };

  constructor(opts?: {
    maxOutputBytes?: number;
    injectedCredentialValues?: string[];
    logger?: { info: (msg: Record<string, unknown>) => void };
  }) {
    this.maxOutputBytes = opts?.maxOutputBytes ?? 100_000; // 100KB default
    this.injectedCredentialValues = new Set(opts?.injectedCredentialValues ?? []);
    this.logger = opts?.logger;
  }

  /**
   * Sanitize exec result output before returning to the LLM.
   */
  sanitize(stdout: string, stderr: string): { stdout: string; stderr: string } {
    const rawHash = createHash('sha256').update(stdout).digest('hex').slice(0, 16);
    this.logger?.info({
      message: 'Sanitizing sandbox output',
      outputHash: rawHash,
      rawLength: stdout.length,
    });

    let sanitizedStdout = this.sanitizeString(stdout);
    let sanitizedStderr = this.sanitizeString(stderr);

    if (sanitizedStdout.length > this.maxOutputBytes) {
      sanitizedStdout = sanitizedStdout.slice(0, this.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
    }
    if (sanitizedStderr.length > this.maxOutputBytes) {
      sanitizedStderr = sanitizedStderr.slice(0, this.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
    }

    return { stdout: sanitizedStdout, stderr: sanitizedStderr };
  }

  /**
   * Sanitize a JSON-serialized object (used for browser_evaluate, MCP results).
   * Walks the structure, applies sanitizeString to all string values,
   * truncates binary base64 fields > 5MB.
   */
  sanitizeObject(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      if (value.length > MAX_BINARY_FIELD_BYTES) {
        return '[BINARY_FIELD_TRUNCATED]';
      }
      return this.sanitizeString(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(v => this.sanitizeObject(v));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.sanitizeObject(v);
      }
      return out;
    }
    return value;
  }

  private sanitizeString(input: string): string {
    let output = input;

    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, REDACTED);
    }

    for (const value of this.injectedCredentialValues) {
      if (value.length >= 8) {
        output = output.split(value).join(REDACTED);
      }
    }

    output = output.replace(ANSI_ESCAPE, '');

    return output;
  }
}
