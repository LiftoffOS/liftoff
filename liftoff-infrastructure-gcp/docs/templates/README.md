# Service-repo templates (Phase 0e)

When a new Liftoff service repo is first created (Phase 1, 1.5, 2, 3),
copy the files below into it. They close the Phase 0e gaps on
dependency hygiene + SLSA-3 provenance without requiring the repos to
exist up-front.

| Target path in new repo                        | Source template here                       |
|------------------------------------------------|--------------------------------------------|
| `.github/dependabot.yml`                       | `dependabot.yml`                           |
| `.github/workflows/npm-audit.yml`              | `npm-audit.yml`                            |
| `cloudbuild.yaml` (append SLSA-3 section)      | `cloudbuild-slsa3-snippet.yaml`            |

## Provenance

Plan 0e requires SLSA-3 provenance on every build. `options.requestedVerifyOption
= VERIFIED` + the `binauthz attestations sign-and-create` step together
satisfy SLSA-3 level 3 (signed provenance produced by the build service,
pinned by image digest). The project-level binauthz admission policy
(`terraform/modules/binauthz-admission/`) refuses any image without a
valid attestation from the appropriate per-service attestor.

## Dependabot scope

Three ecosystems per repo: npm, github-actions, docker. The weekly
schedule aligns with existing platform rotations so the on-call picks
up the security-branch PRs predictably.
