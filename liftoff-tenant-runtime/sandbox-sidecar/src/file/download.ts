import type { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';

export async function downloadFile(req: Request, res: Response): Promise<void> {
  const path = req.query.path as string | undefined;
  if (!path) {
    res.status(400).json({ error: 'path query parameter required' });
    return;
  }
  const resolved = validateWorkspacePath(path);
  try {
    const stat = await fs.stat(resolved);
    res.setHeader('Content-Length', stat.size.toString());
    res.setHeader('Content-Type', 'application/octet-stream');
    createReadStream(resolved).pipe(res);
  } catch {
    res.status(404).json({ error: 'file_not_found' });
  }
}
