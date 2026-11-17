import { execFile } from 'child_process';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';

export async function grep(
  pattern: string,
  rootPath?: string,
  glob?: string,
  opts?: { case_insensitive?: boolean; max_results?: number },
): Promise<{ matches: Array<{ path: string; line: number; text: string }> }> {
  const root = validateWorkspacePath(rootPath ?? '/workspace');
  const args: string[] = ['--json', '--no-heading'];
  if (opts?.case_insensitive) args.push('-i');
  if (glob) args.push('-g', glob);
  if (opts?.max_results) args.push('--max-count', String(opts.max_results));
  args.push(pattern, root);

  return new Promise(resolve => {
    execFile('rg', args, { maxBuffer: 10 * 1024 * 1024 }, (_err, stdout) => {
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'match') {
            matches.push({
              path: obj.data.path.text,
              line: obj.data.line_number,
              text: obj.data.lines.text.replace(/\n$/, ''),
            });
          }
        } catch {
          // ignore non-JSON lines
        }
      }
      resolve({ matches });
    });
  });
}
