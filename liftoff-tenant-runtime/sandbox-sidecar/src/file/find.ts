import { execFile } from 'child_process';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';

export async function findFiles(
  pattern: string,
  rootPath?: string,
  type?: 'f' | 'd',
  maxDepth?: number,
): Promise<{ paths: string[] }> {
  const root = validateWorkspacePath(rootPath ?? '/workspace');
  const args: string[] = [];
  if (type) args.push('--type', type);
  if (maxDepth !== undefined) args.push('--max-depth', String(maxDepth));
  args.push(pattern, root);
  return new Promise(resolve => {
    execFile('fd', args, { maxBuffer: 10 * 1024 * 1024 }, (_err, stdout) => {
      const paths = stdout.split('\n').filter(l => l.trim().length > 0);
      resolve({ paths });
    });
  });
}
