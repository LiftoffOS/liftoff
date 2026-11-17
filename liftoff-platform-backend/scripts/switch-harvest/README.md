# Switch fixture harvest

Primary adapter fixtures are **harvested from the real products**, not authored.
A fixture written from the same reading of upstream as the adapter shares the
adapter's misunderstandings and proves nothing about the real on-disk layout.

No pre-existing installation is required. Both sources are local-first
open-source products, and `harvest.sh` creates each installation from scratch in
a disposable container at a pinned revision.

## Pinned revisions

| Source      | Revision   | Verified   | Harvested |
|-------------|------------|------------|-----------|
| OpenClaw    | `b689bf06` | 2026-09-08 | no        |
| Hermes      | `f03ed94`  | 2026-09-08 | no        |
| Claude Code | `2.x`      | 2026-09-08 | no        |
| Codex       | `0.5x`     | 2026-09-08 | no        |

**Harvested is `no` for every row, and that is the current state of this
pipeline, not an oversight.** The revisions above were verified by reading each
product's own source and a live installation, and the SYNTHETIC fixtures in
`switch-fixtures.ts` were rewritten to the layouts found there. This harness has
not been re-run since — it needs Docker, a network, and a driven install of each
product — so no harvested generation exists at these revisions.

That distinction matters when reading a green test run. The synthetic fixtures
prove the mechanical properties (containment, bounds, redaction, packing,
determinism, the do-not-import rules) and now also the real directory layouts.
They do not prove the layouts are still what upstream writes, which is the one
thing only a harvest can prove.

Bumping a revision **re-runs this script and adds a new fixture generation**. It
never edits an existing one: an adapter updated for an upstream schema change
must add a new fixture rather than silently changing old expectations.

The revision recorded here is also the one named in each adapter's header
comment. The two must agree — an adapter claiming a revision this table does not
list is an adapter written against a layout nobody recorded.

## Files here, and what is still to be authored

| File | Status |
|------|--------|
| `harvest.sh` | Complete. The harness: build, drive, snapshot, scrub, record provenance. |
| `scrub.js` | Complete. Replaces credentials with **format-realistic** fakes. |
| `Dockerfile.openclaw`, `Dockerfile.hermes` | **Authored during the interactive pass** (below). |
| `drive.sh` | **Authored during the interactive pass** (below). |

The two missing pieces are deliberately not guessed. The plan's first harvest
stage is interactive: the adapter author installs the product, uses it, and
observes where state lands — and **that session is the primary research act**,
the thing the adapter gets written against. The install procedure and the exact
CLI invocations that produce importable state are outputs of that session, not
inputs to it. Writing them from a reading of upstream docs would reproduce the
authored-fixture trap one level up: a harvest script that looks complete and
fails on first contact with the real product.

`harvest.sh` therefore fails loudly if they are absent rather than silently
producing an empty fixture.

## What a harvest run does

1. Builds a container for one source at its pinned revision.
2. Runs the product's own CLI to create agents/profiles, skills, memories, cron
   jobs, MCP definitions and channel configuration, using throwaway or fake
   credentials. **No model key is needed for this stage** — it produces most of
   the importable surface.
3. Runs a short burst of real agent turns with a throwaway model key so
   execution-born state exists: session databases with their real schemas,
   accumulated memories, WAL files. The key lives only inside the container and
   is never committed.
4. Snapshots the state directories twice: once cleanly, and once with the
   gateway killed mid-write, so read-only SQLite and WAL handling is exercised
   against genuinely unclean state.
5. Scrubs secrets into format-realistic fakes.
6. Writes the result under `fixtures/<source>/<revision>/`.

Import testing does **not** require a running source: adapters read state at
rest, so the product is needed only at harvest time. No long-running service is
maintained anywhere.

## Teardown

Harvest environments are disposable: **one pristine container per source, torn
down by deletion.** Product uninstall paths are never relied on for
cleanliness — a fast-moving product's uninstaller is exactly what leaves behind
launchd entries, state roots and global bins.

Per-source isolation is the real requirement behind "one at a time": it keeps
observed state changes attributable to one product. With isolated containers the
two sources do not need to be harvested serially.

### Organic-usage machines

Organic fixtures (a team member using the product normally for a few days on
their own machine) are a **coverage strengthener and do not gate launch**. They
run on a real machine, so they end with a documented teardown:

- the state root, and any overridden home (`OPENCLAW_HOME`, `HERMES_HOME`)
- the installed binary
- any registered launchd or systemd service
- any shell-rc or keychain additions

Teardown is verified mechanically, by running our own detector against the
machine:

```bash
npx @liftoffos/cli@latest switch --from openclaw --json   # must report no_installation
npx @liftoffos/cli@latest switch --from hermes  --json    # must report no_installation
```

That doubles as a free test of `detect()`'s negative case before the machine is
wiped.

## Upstream drift canary

`drift-canary.sh` installs the **latest** release of each source weekly in CI,
generates the scripted installation, and runs `detect` and `inventory` against
it. A parse failure or an unknown new field alerts before a user's machine finds
it, and answers when a new pinned fixture is due.

This is not optional hygiene. Upstream velocity is extreme: Hermes landed ~1,400
commits in ten days during its plugin-architecture pivot, and OpenClaw ships
monthly at a size larger than the other evaluated harnesses combined. Fixtures
go stale fast, which is why the generation script is committed rather than the
harvest being a one-off act of archaeology.
