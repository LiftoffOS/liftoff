import { execFile, ExecFileException } from 'child_process';
import { config } from '../config';
import type { ShellExecRequest, ShellExecResponse } from '@liftoffos/sandbox-contracts';

const MAX_OUTPUT_BYTES = config.maxOutputBytes;

export async function shellExec(req: ShellExecRequest): Promise<ShellExecResponse> {
  const { args, workDir, timeout, env } = req;
  if (!args || !Array.isArray(args) || args.length === 0) {
    throw new Error('args must be a non-empty array');
  }
  const [command, ...cmdArgs] = args;
  const cwd = workDir ?? config.workspaceDir;
  const timeoutMs = Math.min(timeout ?? 60_000, 300_000);

  return new Promise<ShellExecResponse>(resolve => {
    execFile(
      command,
      cmdArgs,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        // SECURITY: Do not spread process.env — only pass safe base vars + caller-provided env.
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME || '/tmp',
          LANG: process.env.LANG || 'en_US.UTF-8',
          TERM: 'xterm-256color',
          WORKSPACE_DIR: config.workspaceDir,
          TMPDIR: '/tmp',
          ...env,
        },
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        resolve({
          stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}
