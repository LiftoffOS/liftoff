// Anthropic str_replace_editor — exact 5-command taxonomy.
// view | create | str_replace | insert | undo_edit

import { promises as fs } from 'fs';
import { dirname } from 'path';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import { SandboxApiError } from '../shared/errors';
import { SANDBOX_ERROR_CODES, type StrReplaceEditorRequest } from '@liftoffos/sandbox-contracts';

interface EditHistoryEntry {
  previousContent: string;
  timestamp: number;
}

const HISTORY_PER_FILE = 5;
const history = new Map<string, EditHistoryEntry[]>();

function pushHistory(absPath: string, previousContent: string) {
  const arr = history.get(absPath) ?? [];
  arr.push({ previousContent, timestamp: Date.now() });
  while (arr.length > HISTORY_PER_FILE) arr.shift();
  history.set(absPath, arr);
}

function popHistory(absPath: string): EditHistoryEntry | null {
  const arr = history.get(absPath);
  if (!arr || arr.length === 0) return null;
  const entry = arr.pop()!;
  history.set(absPath, arr);
  return entry;
}

function formatViewLines(content: string, range?: [number, number]): string {
  const lines = content.split('\n');
  const start = range?.[0] ?? 1;
  const end = range?.[1] ?? lines.length;
  const out: string[] = [];
  for (let i = start; i <= Math.min(end, lines.length); i++) {
    out.push(`${String(i).padStart(4, ' ')}\t${lines[i - 1]}`);
  }
  return out.join('\n');
}

async function viewDirectory(absPath: string, depth = 2): Promise<string> {
  const entries: string[] = [];
  async function walk(dir: string, level: number) {
    if (level > depth) return;
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const indent = '  '.repeat(level);
      entries.push(`${indent}${item.isDirectory() ? item.name + '/' : item.name}`);
      if (item.isDirectory()) {
        await walk(`${dir}/${item.name}`, level + 1);
      }
    }
  }
  await walk(absPath, 0);
  return entries.join('\n');
}

export async function strReplaceEditor(req: StrReplaceEditorRequest): Promise<{ result: string }> {
  const absPath = validateWorkspacePath(req.path);

  switch (req.command) {
    case 'view': {
      try {
        const stat = await fs.stat(absPath);
        if (stat.isDirectory()) {
          return { result: await viewDirectory(absPath) };
        }
        const content = await fs.readFile(absPath, 'utf-8');
        return { result: formatViewLines(content, req.view_range) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SandboxApiError(SANDBOX_ERROR_CODES.FILE_NOT_FOUND, 404, `not found: ${req.path}`);
        }
        throw err;
      }
    }
    case 'create': {
      try {
        await fs.access(absPath);
        throw new SandboxApiError(SANDBOX_ERROR_CODES.FILE_EXISTS, 409, `already exists: ${req.path}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (err instanceof SandboxApiError) throw err;
          throw err;
        }
      }
      await fs.mkdir(dirname(absPath), { recursive: true });
      const content = req.file_text ?? '';
      await fs.writeFile(absPath, content, 'utf-8');
      pushHistory(absPath, '');
      return { result: `created: ${req.path}` };
    }
    case 'str_replace': {
      if (req.old_str === undefined || req.new_str === undefined) {
        throw new SandboxApiError(SANDBOX_ERROR_CODES.OLD_STR_NOT_FOUND, 400, 'old_str and new_str required');
      }
      const current = await fs.readFile(absPath, 'utf-8');
      let occurrences = 0;
      let idx = current.indexOf(req.old_str);
      while (idx !== -1) {
        occurrences++;
        idx = current.indexOf(req.old_str, idx + req.old_str.length);
      }
      if (occurrences === 0) {
        throw new SandboxApiError(SANDBOX_ERROR_CODES.OLD_STR_NOT_FOUND, 400, 'old_str not found');
      }
      if (occurrences > 1) {
        throw new SandboxApiError(SANDBOX_ERROR_CODES.OLD_STR_NOT_UNIQUE, 400, 'old_str not unique', { occurrences });
      }
      pushHistory(absPath, current);
      const updated = current.replace(req.old_str, req.new_str);
      await fs.writeFile(absPath, updated, 'utf-8');
      return { result: `replaced 1 occurrence in ${req.path}` };
    }
    case 'insert': {
      if (req.insert_line === undefined || req.new_str === undefined) {
        throw new SandboxApiError(SANDBOX_ERROR_CODES.OLD_STR_NOT_FOUND, 400, 'insert_line and new_str required');
      }
      const current = await fs.readFile(absPath, 'utf-8');
      const lines = current.split('\n');
      const insertAt = Math.max(0, Math.min(req.insert_line, lines.length));
      pushHistory(absPath, current);
      const before = lines.slice(0, insertAt);
      const after = lines.slice(insertAt);
      const insertLines = req.new_str.split('\n');
      const result = [...before, ...insertLines, ...after].join('\n');
      await fs.writeFile(absPath, result, 'utf-8');
      return { result: `inserted at line ${insertAt} in ${req.path}` };
    }
    case 'undo_edit': {
      const prev = popHistory(absPath);
      if (!prev) {
        throw new SandboxApiError(SANDBOX_ERROR_CODES.NO_HISTORY, 400, 'no history');
      }
      if (prev.previousContent === '') {
        // It was a create — delete the file
        await fs.unlink(absPath).catch(() => undefined);
        return { result: `undone create: ${req.path}` };
      }
      await fs.writeFile(absPath, prev.previousContent, 'utf-8');
      return { result: `undone edit on ${req.path}` };
    }
    default:
      throw new SandboxApiError(SANDBOX_ERROR_CODES.UNSUPPORTED_FORMAT, 400, `unknown command: ${(req as { command: string }).command}`);
  }
}
