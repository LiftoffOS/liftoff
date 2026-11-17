import { Router } from 'express';
import { execFile } from 'child_process';
import { asyncHandler } from '../shared/error-middleware';

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (_err, stdout, stderr) => resolve({ stdout, stderr }));
  });
}

export const packagesRoutes = Router();

packagesRoutes.get(
  '/python',
  asyncHandler(async (_req, res) => {
    const { stdout } = await exec('/opt/py-tools/bin/pip', ['list', '--format=json']);
    let parsed: Array<{ name: string; version: string }> = [];
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // ignore
    }
    res.json({ packages: parsed });
  }),
);

packagesRoutes.get(
  '/nodejs',
  asyncHandler(async (_req, res) => {
    const { stdout } = await exec('npm', ['list', '-g', '--json', '--depth=0']);
    let pkgs: Array<{ name: string; version: string }> = [];
    try {
      const obj = JSON.parse(stdout) as { dependencies?: Record<string, { version: string }> };
      pkgs = Object.entries(obj.dependencies ?? {}).map(([name, v]) => ({ name, version: v.version }));
    } catch {
      // ignore
    }
    res.json({ packages: pkgs });
  }),
);
