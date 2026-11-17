// Read an installed dependency's version at runtime.
//
// The obvious `require('<pkg>/package.json').version` throws
// ERR_PACKAGE_PATH_NOT_EXPORTED for any package whose `exports` map does not
// expose `./package.json` (most modern SDKs). That silent failure is why the
// native-artifact envelope's producer_runtime_version and the live-cert
// runtimeVersion both came back null / 'unknown'. This resolves the package's
// real entry point, then walks up to the nearest package.json whose `name`
// matches, and reads its version — working regardless of the exports map.

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

export function readPackageVersion(pkg: string): string | null {
  // Fast path: packages that DO export ./package.json.
  try {
    return (require(`${pkg}/package.json`) as { version?: string }).version ?? null;
  } catch {
    // exports-restricted — fall through to resolve + walk.
  }
  try {
    let dir = dirname(require.resolve(pkg));
    for (let i = 0; i < 12; i += 1) {
      const pj = join(dir, 'package.json');
      if (existsSync(pj)) {
        const parsed = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; version?: string };
        // Match on name so a nested dependency's package.json can't masquerade
        // as the one we asked for.
        if (parsed.name === pkg) return parsed.version ?? null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Not resolvable in this runtime.
  }
  return null;
}
