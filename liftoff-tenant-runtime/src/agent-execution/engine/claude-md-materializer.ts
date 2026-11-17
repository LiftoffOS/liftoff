// Claude Agent SDK workspace materializer.
//
// The Claude Agent SDK loads project-level CLAUDE.md from its `cwd` when
// invoked with `settingSources: ['project']` + `systemPrompt: { type: 'preset',
// preset: 'claude_code' }`. This helper creates an isolated per-invocation
// working directory and HOME under /tmp (the only writable path on Cloud Run),
// writes the CLAUDE.md file, and returns an idempotent cleanup function the
// caller must invoke in a finally block.
//
// Isolation is per-invocation, not per-agent: multiple agents run concurrently
// in one Cloud Run instance, and a shared cwd races on the CLAUDE.md write
// between concurrent invocations.

import { promises as fs } from 'fs';
import * as path from 'path';
import { execFile as cpExecFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync } from 'fs';
import { logger } from '../../infrastructure/logging';

const execFile = promisify(cpExecFile);
const MIRROR_BASE = '/tmp/mirrors';

// Process-level mirror cache — survives across invocations on the same Cloud Run instance.
const mirrorCache = new Map<string, string>();

async function getOrUpdateMirror(cloneUrl: string): Promise<string> {
  let cacheKey = cloneUrl;
  try {
    const u = new URL(cloneUrl);
    u.password = '';
    u.username = '';
    cacheKey = u.toString();
  } catch { /* not a full URL */ }

  const slug = Buffer.from(cacheKey).toString('base64url').slice(0, 40);
  const mirrorPath = `${MIRROR_BASE}/${slug}.git`;

  if (mirrorCache.has(cacheKey)) {
    await execFile('git', ['fetch', '--prune', 'origin'], { cwd: mirrorPath }).catch(() => {});
  } else {
    mkdirSync(MIRROR_BASE, { recursive: true });
    await execFile('git', ['clone', '--mirror', cloneUrl, mirrorPath], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    mirrorCache.set(cacheKey, mirrorPath);
  }

  return mirrorPath;
}

export interface RepoConfig {
  cloneUrl: string;
  branch?: string;
  slug?: string;
}

export interface InvocationWorkspace {
  cwd: string;
  home: string;
  cleanup: () => Promise<void>;
}

const INVOCATION_ID_PATTERN = /^[a-f0-9-]{36}$/;
const INVOCATIONS_ROOT = '/tmp/invocations';

const SANDBOX_TOOL_MAP: Record<string, string> = {
  sandbox__shell_exec: 'Bash',
  sandbox__file_read: 'Read',
  sandbox__file_write: 'Write',
  sandbox__file_edit: 'Edit',
  sandbox__file_search: 'Glob',
  sandbox__content_search: 'Grep',
  sandbox__git_clone: 'Bash',
  sandbox__git_commit_and_push: 'Bash',
};
const SANDBOX_TOOL_PATTERN = new RegExp(Object.keys(SANDBOX_TOOL_MAP).join('|'), 'g');

function normalizeSandboxToolNames(content: string): string {
  return content.replace(SANDBOX_TOOL_PATTERN, (match) => SANDBOX_TOOL_MAP[match] ?? match);
}

/**
 * Create an isolated workspace for a single agent invocation.
 *
 * Layout:
 *   /tmp/invocations/<invocationId>/          ← cwd (CLAUDE.md lives here)
 *   /tmp/invocations/<invocationId>/home/     ← HOME (SDK writes ~/.claude here)
 *
 * The invocationId must match the 36-char lowercase UUID pattern. Any other
 * shape is rejected to prevent path traversal via a malicious id (e.g. one
 * containing `..` or `/`).
 */
export async function materializeInvocationWorkspace(
  invocationId: string,
  claudeMdContent: string | null,
  repos?: RepoConfig[],
): Promise<InvocationWorkspace> {
  if (!INVOCATION_ID_PATTERN.test(invocationId)) {
    throw new Error(`materializeInvocationWorkspace: invalid invocationId shape: ${JSON.stringify(invocationId)}`);
  }

  const cwd = path.join(INVOCATIONS_ROOT, invocationId);
  const home = path.join(cwd, 'home');

  await fs.mkdir(home, { recursive: true });
  if (claudeMdContent !== null) {
    await fs.writeFile(path.join(cwd, 'CLAUDE.md'), normalizeSandboxToolNames(claudeMdContent), 'utf8');
  }

  if (repos && repos.length > 0) {
    await Promise.all(repos.map(async (repo) => {
      let slug = repo.slug;
      if (!slug) {
        try {
          const pathname = new URL(repo.cloneUrl.replace(/^git@([^:]+):/, 'https://$1/')).pathname;
          slug = pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? 'repo';
        } catch {
          slug = 'repo';
        }
      }
      const destDir = path.join(cwd, slug);
      try {
        const mirrorPath = await getOrUpdateMirror(repo.cloneUrl);
        await execFile('git', ['clone', '--local', '--no-hardlinks', mirrorPath, destDir], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        await execFile('git', ['-C', destDir, 'remote', 'set-url', 'origin', repo.cloneUrl]);
        if (repo.branch) {
          await execFile('git', ['-C', destDir, 'checkout', repo.branch]);
        }
      } catch (err) {
        logger.warn({ err, slug, invocationId }, 'Non-fatal: pre-clone failed for repo');
      }
    }));
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await fs.rm(cwd, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ invocationId, cwd, err: (err as Error).message }, 'invocation workspace cleanup failed');
    }
  };

  return { cwd, home, cleanup };
}
