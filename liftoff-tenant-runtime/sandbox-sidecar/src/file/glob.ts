import fg from 'fast-glob';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';

export async function globPaths(pattern: string, root?: string): Promise<{ paths: string[] }> {
  const cwd = validateWorkspacePath(root ?? '/workspace');
  const matches = await fg(pattern, { cwd, dot: true, absolute: true, ignore: ['node_modules', '.git'] });
  return { paths: matches };
}
