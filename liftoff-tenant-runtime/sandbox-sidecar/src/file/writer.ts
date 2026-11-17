import { promises as fs } from 'fs';
import { dirname } from 'path';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import { getFreeBytes } from '../health';
import { WorkspaceFullError } from '../shared/errors';
import { config } from '../config';

const WORKSPACE_FULL_THRESHOLD = 100 * 1024 * 1024;

export async function writeFileContent(
  path: string,
  content: string,
  encoding: 'utf-8' | 'base64' = 'utf-8',
  makeDirs = true,
): Promise<{ path: string; bytesWritten: number }> {
  const resolved = validateWorkspacePath(path);
  const free = await getFreeBytes(config.workspaceDir);
  if (free < WORKSPACE_FULL_THRESHOLD) {
    throw new WorkspaceFullError(free);
  }
  if (makeDirs) {
    await fs.mkdir(dirname(resolved), { recursive: true });
  }
  const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
  await fs.writeFile(resolved, buf);
  return { path: resolved, bytesWritten: buf.length };
}

export async function replaceInFile(
  path: string,
  oldText: string,
  newText: string,
): Promise<{ path: string; replacements: number }> {
  const resolved = validateWorkspacePath(path);
  const current = await fs.readFile(resolved, 'utf-8');
  const replaced = current.split(oldText).join(newText);
  const count = (current.length - replaced.length) / Math.max(1, oldText.length - newText.length);
  await fs.writeFile(resolved, replaced);
  return { path: resolved, replacements: Math.max(0, Math.round(count)) };
}
