#!/usr/bin/env python3
"""Build every workspace member in DEPENDENCY order and report per-member status.

Use this instead of `npm run build --workspaces --if-present`, which is the obvious
command and the wrong one: npm runs members in the order they are listed, so the
services compile before the packages they import and the run ends in hundreds of
TS2307 "cannot find module" errors that read like a broken tree and are a build
order. The packages carry no committed dist/, so there is nothing to find until
they are built.

    python3 scripts/build-all.py [path/to/repo]
"""
import json, subprocess, sys
from pathlib import Path


def _find_root() -> Path:
    """The workspace root: an explicit argument, else the nearest ancestor of the
    working directory whose package.json has a `workspaces` key, else the
    repository root this script lives in.
    """
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).resolve()
    here = Path.cwd().resolve()
    for d in (here, *here.parents):
        pj = d / 'package.json'
        if pj.is_file():
            try:
                if 'workspaces' in json.loads(pj.read_text()):
                    return d
            except (ValueError, OSError):
                pass
    return Path(__file__).resolve().parent.parent


ROOT = _find_root()
members = json.loads((ROOT / 'package.json').read_text())['workspaces']

info = {}
for m in members:
    d = json.loads((ROOT / m / 'package.json').read_text())
    deps = set()
    for k in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'):
        deps |= {x for x in (d.get(k) or {}) if x.startswith('@liftoffos/')}
    info[d['name']] = {'path': m, 'deps': deps,
                       'build': bool((d.get('scripts') or {}).get('build'))}

names = set(info)
order, seen, stack = [], set(), set()

def visit(n):
    if n in seen:
        return
    if n in stack:
        print('CYCLE at', n); return
    stack.add(n)
    for dep in sorted(info[n]['deps'] & names):
        visit(dep)
    stack.discard(n)
    seen.add(n)
    order.append(n)

for n in sorted(names):
    visit(n)

print('build order (%d members, %d with a build script):' % (len(order), sum(1 for n in order if info[n]['build'])))
results = []
for n in order:
    if not info[n]['build']:
        continue
    r = subprocess.run(['npm', 'run', 'build', '-w', info[n]['path'],
                        '--userconfig=/dev/null', '--if-present'],
                       cwd=ROOT, capture_output=True, text=True)
    ok = r.returncode == 0
    errs = r.stdout.count('error TS') + r.stderr.count('error TS')
    results.append((n, ok, errs))
    print('  %-4s %-36s %s' % ('OK' if ok else 'FAIL', n, ('' if ok else '%d TS errors' % errs)))
    if not ok:
        tail = (r.stdout + r.stderr).strip().splitlines()
        for line in [l for l in tail if 'error TS' in l][:6]:
            print('        ', line.strip()[:150])

bad = [r for r in results if not r[1]]
print()
print('%d/%d built, %d failed' % (len(results) - len(bad), len(results), len(bad)))
sys.exit(1 if bad else 0)
