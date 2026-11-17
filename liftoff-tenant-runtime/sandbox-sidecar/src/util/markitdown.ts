import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import { SandboxApiError, FileTooLargeError } from '../shared/errors';
import { SANDBOX_ERROR_CODES } from '@liftoffos/sandbox-contracts';

const MAX_INPUT_BYTES = 50 * 1024 * 1024;

export async function convertToMarkdown(opts: { path?: string; content?: string; mime?: string }): Promise<{ markdown: string }> {
  let resolvedPath: string;
  let cleanup: (() => Promise<void>) | null = null;

  if (opts.path) {
    resolvedPath = validateWorkspacePath(opts.path);
    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.size > MAX_INPUT_BYTES) throw new FileTooLargeError(MAX_INPUT_BYTES);
    } catch (err) {
      if (err instanceof FileTooLargeError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SandboxApiError(SANDBOX_ERROR_CODES.FILE_NOT_FOUND, 400, `not found: ${opts.path}`);
      }
      throw err;
    }
  } else if (opts.content !== undefined) {
    const tmp = join(tmpdir(), `markitdown-${randomUUID()}`);
    await fs.writeFile(tmp, opts.content, 'utf-8');
    resolvedPath = tmp;
    cleanup = async () => fs.unlink(tmp).catch(() => undefined);
  } else {
    throw new SandboxApiError(SANDBOX_ERROR_CODES.UNSUPPORTED_FORMAT, 400, 'path or content required');
  }

  try {
    return await new Promise<{ markdown: string }>((resolve, reject) => {
      execFile('markitdown', [resolvedPath], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const text = (stderr ?? '').toLowerCase();
          if (text.includes('encryption') || text.includes('password')) {
            reject(new SandboxApiError(SANDBOX_ERROR_CODES.PASSWORD_PROTECTED, 400, 'password-protected file'));
            return;
          }
          if (text.includes('unsupported')) {
            reject(new SandboxApiError(SANDBOX_ERROR_CODES.UNSUPPORTED_FORMAT, 415, 'unsupported format', { detected_mime: opts.mime }));
            return;
          }
          reject(new SandboxApiError(SANDBOX_ERROR_CODES.CONVERSION_FAILED, 500, 'conversion_failed', { stderr }));
          return;
        }
        resolve({ markdown: stdout });
      });
    });
  } finally {
    if (cleanup) await cleanup();
  }
}
