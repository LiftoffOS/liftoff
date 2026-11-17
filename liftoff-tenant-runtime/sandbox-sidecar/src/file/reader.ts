import { promises as fs } from 'fs';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import { SandboxApiError } from '../shared/errors';
import { SANDBOX_ERROR_CODES } from '@liftoffos/sandbox-contracts';

export async function readFileContent(
  path: string,
  offset = 0,
  limit?: number,
  encoding: 'utf-8' | 'base64' = 'utf-8',
): Promise<{ content: string; totalBytes: number }> {
  const resolved = validateWorkspacePath(path);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new SandboxApiError(SANDBOX_ERROR_CODES.FILE_NOT_FOUND, 400, 'not a regular file');
    }
    const totalBytes = stat.size;
    const handle = await fs.open(resolved, 'r');
    try {
      const readLen = limit !== undefined ? Math.min(limit, totalBytes - offset) : totalBytes - offset;
      const buf = Buffer.alloc(Math.max(0, readLen));
      if (buf.length > 0) {
        await handle.read(buf, 0, buf.length, offset);
      }
      return {
        content: encoding === 'base64' ? buf.toString('base64') : buf.toString('utf-8'),
        totalBytes,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err instanceof SandboxApiError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SandboxApiError(SANDBOX_ERROR_CODES.FILE_NOT_FOUND, 404, `not found: ${path}`);
    }
    throw err;
  }
}
