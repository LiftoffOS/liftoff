import { Router } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import { readFileContent } from './reader';
import { writeFileContent, replaceInFile } from './writer';
import { strReplaceEditor } from './editor';
import { grep } from './search';
import { findFiles } from './find';
import { globPaths } from './glob';
import { watcherRegistry } from './watcher';
import { uploadFile } from './upload';
import { downloadFile } from './download';
import { asyncHandler } from '../shared/error-middleware';
import type {
  FileReadRequest,
  FileWriteRequest,
  FileReplaceRequest,
  StrReplaceEditorRequest,
  FileSearchRequest,
  FileFindRequest,
  FileGrepRequest,
  FileGlobRequest,
  FileListRequest,
  FileWatchCreateRequest,
  FileWatchPollRequest,
  FileWatchWaitRequest,
  FileWatchStopRequest,
} from '@liftoffos/sandbox-contracts';

export const fileRoutes = Router();

fileRoutes.post(
  '/read',
  asyncHandler(async (req, res) => {
    const body = req.body as FileReadRequest;
    res.json(await readFileContent(body.path, body.offset, body.limit, body.encoding));
  }),
);

fileRoutes.post(
  '/write',
  asyncHandler(async (req, res) => {
    const body = req.body as FileWriteRequest;
    res.json(await writeFileContent(body.path, body.content, body.encoding, body.makeDirs ?? true));
  }),
);

fileRoutes.post(
  '/replace',
  asyncHandler(async (req, res) => {
    const body = req.body as FileReplaceRequest;
    res.json(await replaceInFile(body.path, body.oldText, body.newText));
  }),
);

fileRoutes.post(
  '/str_replace_editor',
  asyncHandler(async (req, res) => {
    res.json(await strReplaceEditor(req.body as StrReplaceEditorRequest));
  }),
);

fileRoutes.post(
  '/search',
  asyncHandler(async (req, res) => {
    const body = req.body as FileSearchRequest;
    res.json(await grep(body.pattern, body.path, body.glob, {
      case_insensitive: body.case_insensitive,
      max_results: body.max_results,
    }));
  }),
);

fileRoutes.post(
  '/find',
  asyncHandler(async (req, res) => {
    const body = req.body as FileFindRequest;
    res.json(await findFiles(body.pattern, body.path, body.type, body.max_depth));
  }),
);

fileRoutes.post(
  '/grep',
  asyncHandler(async (req, res) => {
    const body = req.body as FileGrepRequest;
    res.json(await grep(body.pattern, body.path, body.glob));
  }),
);

fileRoutes.post(
  '/glob',
  asyncHandler(async (req, res) => {
    const body = req.body as FileGlobRequest;
    res.json(await globPaths(body.pattern, body.root));
  }),
);

fileRoutes.post(
  '/list',
  asyncHandler(async (req, res) => {
    const body = req.body as FileListRequest;
    const root = validateWorkspacePath(body.path);
    const max = body.recursive ? (body.max_depth ?? 5) : 1;
    const entries: Array<{ name: string; type: 'file' | 'dir' | 'symlink'; size: number; mtime: string }> = [];
    async function walk(dir: string, depth: number) {
      if (depth > max) return;
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const full = join(dir, item.name);
        const stat = await fs.lstat(full);
        const type: 'file' | 'dir' | 'symlink' = item.isDirectory()
          ? 'dir'
          : item.isSymbolicLink()
          ? 'symlink'
          : 'file';
        entries.push({ name: full, type, size: stat.size, mtime: stat.mtime.toISOString() });
        if (item.isDirectory()) await walk(full, depth + 1);
      }
    }
    await walk(root, 1);
    res.json({ entries });
  }),
);

fileRoutes.post(
  '/upload',
  asyncHandler(async (req, res) => {
    const targetPath = (req.query.path as string) || (req.headers['x-file-path'] as string);
    res.json(await uploadFile(req, targetPath));
  }),
);

fileRoutes.get(
  '/download',
  asyncHandler(async (req, res) => {
    await downloadFile(req, res);
  }),
);

fileRoutes.post(
  '/watch/create',
  asyncHandler(async (req, res) => {
    const body = req.body as FileWatchCreateRequest;
    res.json(watcherRegistry.create(body.paths));
  }),
);

fileRoutes.get(
  '/watch/list',
  asyncHandler(async (_req, res) => {
    res.json({ watchers: watcherRegistry.list() });
  }),
);

fileRoutes.post(
  '/watch/poll',
  asyncHandler(async (req, res) => {
    const body = req.body as FileWatchPollRequest;
    res.json(watcherRegistry.poll(body.watcher_id, body.since));
  }),
);

fileRoutes.post(
  '/watch/wait',
  asyncHandler(async (req, res) => {
    const body = req.body as FileWatchWaitRequest;
    const events = await watcherRegistry.wait(body.watcher_id, body.timeout_ms);
    res.json({ events });
  }),
);

fileRoutes.post(
  '/watch/stop',
  asyncHandler(async (req, res) => {
    const body = req.body as FileWatchStopRequest;
    await watcherRegistry.stop(body.watcher_id);
    res.json({ stopped: true });
  }),
);

fileRoutes.get(
  '/watch/events',
  asyncHandler(async (req, res) => {
    const watcherId = req.query.watcher_id as string;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const unsub = watcherRegistry.subscribe(watcherId, evt => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    });
    req.on('close', () => {
      unsub();
    });
  }),
);
