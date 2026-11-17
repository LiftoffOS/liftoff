import type { Request } from 'express';
import { promises as fs, createWriteStream } from 'fs';
import { dirname } from 'path';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';

export async function uploadFile(req: Request, targetPath: string): Promise<{ path: string; bytesWritten: number }> {
  const resolved = validateWorkspacePath(targetPath);
  await fs.mkdir(dirname(resolved), { recursive: true });
  let bytesWritten = 0;
  return new Promise<{ path: string; bytesWritten: number }>((resolve, reject) => {
    const stream = createWriteStream(resolved);
    req.on('data', (chunk: Buffer) => {
      bytesWritten += chunk.length;
      stream.write(chunk);
    });
    req.on('end', () => {
      stream.end(() => resolve({ path: resolved, bytesWritten }));
    });
    req.on('error', reject);
    stream.on('error', reject);
  });
}
