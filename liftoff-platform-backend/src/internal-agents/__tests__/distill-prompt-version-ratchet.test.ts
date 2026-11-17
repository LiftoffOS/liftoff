// Editing the distill prompt without bumping DISTILL_PROMPT_VERSION fails here.
//
// The cache fingerprint is (promptVersion, inputs, catalogHash) and does NOT
// cover the prompt text. So an edited prompt under an unchanged version is served
// from cache for every agent whose inputs and catalog are unchanged: the edit
// reaches nobody, and the only symptom is an agent behaving like the previous
// release. distill-cache.ts states the bump requirement in a comment; a comment
// cannot fail a build, so this does.
//
// When this fails because the prompt changed on purpose:
//   1. bump DISTILL_PROMPT_VERSION and add a changelog line saying what changed,
//   2. update PROMPT_FINGERPRINT below to the value the failure prints.
//
// "The distill prompt" is every text the model reads that the cache key does not
// cover, wherever it lives — including the sections built in their own files and
// concatenated into the user message. See the note on fingerprint() below.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  __internalGetProduceAgentToolText,
  __internalGetPromptText,
  buildDestinationSection,
  buildWorkspaceToolsText,
} from '../distill-service';
import {
  buildReviewCycleContractSection,
  buildIncrementalReviewSection,
} from '../distill-review-cycle-injection';

/** Bump alongside DISTILL_PROMPT_VERSION. */
const PROMPT_VERSION = 'v80';
const PROMPT_FINGERPRINT = '828ee51760b8ac1a';

function fingerprint(): string {
  // Every text the model reads that the cache key does not cover: the system
  // prompt, the workspace-tools section built into the user message, and the
  // produce_agent tool schema.
  //
  // The schema is in here because v6 happened without it. A field description
  // contradicting the system prompt is not a smaller change than editing the
  // prompt — the model weights tool-attached descriptions heavily and followed
  // the schema over the prose. Leaving it out made this ratchet green for the
  // one edit that had already caused a regression.
  //
  // The CONDITIONALLY-INJECTED sections are in here for the same reason the
  // schema is. They are prompt text the model reads, they are not covered by
  // the cache key, and they live in their own files — so an edit to one used to
  // change what every github-bound software-delivery agent is told while this
  // ratchet stayed green and the cache kept serving the previous release. Found
  // by writing v50: rule 4 of the review-cycle contract is a graph-shape
  // instruction naming three tools, and editing it alone moved this hash by
  // nothing at all.
  //
  // Built with fixed arguments, so the hash tracks the TEXT and not a caller's
  // inputs. Predicate-gated sections need arguments that switch them ON, or the
  // fingerprint covers the empty string and proves nothing.
  const reviewCycle = buildReviewCycleContractSection({
    bindsGithub: true,
    templateId: 'code-reviewer',
    escalationRecipient: null,
  });
  // The ANALYZER is in here because it decides the same output the prompt does.
  //
  // Its rules reject a distillation and hand the model retry feedback, so a
  // change to one changes what agents get built. None of that is in the cache
  // key, which covers (promptVersion, inputs, catalogHash) — so a fixed rule is
  // served the previous release's cached answer for every agent whose inputs
  // are unchanged, and the fix reaches nobody: after a Rule 6 fix, the next
  // redistill would return the pre-fix trigger from cache in seconds.
  //
  // Hashing the source, not calling the rules: a rule's effect only shows on
  // inputs that trip it, and the point is to catch an edit to any of them.
  const analyzerSrc = readFileSync(
    join(__dirname, '..', 'trigger-config-analyzer.ts'),
    'utf8',
  );
  // The OBLIGATION FENCES are in here for the identical reason, one file over.
  //
  // findMissingDeliveryStep, findMissingArtifactWrite, findMissingSeriesWrite,
  // findMissingIdempotencyStep and findMissingExtractionStep each reject a
  // distillation and feed the model retry text. They decide the output as much
  // as the analyzer does and they were not hashed, so a corrected fence was
  // answered from cache with the pre-fix graph.
  //
  // For example, if the artifact-write fence is fixed to stop counting an
  // uncategorised read as a write, an unhashed fence lets the next redistill
  // return the same read-only graph from cache in seconds. Same failure the v57
  // note records for Rule 6, in a different file.
  //
  // Read between markers rather than by hashing the whole file: distill-service
  // is five thousand lines and hashing all of it would fire this ratchet on
  // every unrelated edit, which trains people to bump the version without
  // reading why.
  const fencesFile = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');
  const start = fencesFile.indexOf('// ─── OBLIGATION FENCES: START');
  const end = fencesFile.indexOf('// ─── OBLIGATION FENCES: END');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      'OBLIGATION FENCES markers missing from distill-service.ts. They delimit the '
      + 'validators this fingerprint covers; without them a fence edit stops moving the hash '
      + 'and cached distillations outlive the fix.',
    );
  }
  const fencesSrc = fencesFile.slice(start, end);
  // The DESTINATION RULE, for the same reason and in both of its branches.
  //
  // It is prompt text the model reads, it is not covered by the cache key, and
  // it lives in its own file because the prose an agent STORES is resolved from
  // the identical rule (destination-rule.ts). Both branches are hashed: a file
  // destination and a folder destination are given opposite instructions, and
  // hashing one would leave an edit to the other invisible here while the cache
  // kept serving the previous release.
  const destinationFile = buildDestinationSection({
    d: { id: 'FILE_ID', title: 'The Deliverable', kind: 'file' },
  });
  const destinationFolder = buildDestinationSection({
    d: { id: 'FOLDER_ID', title: 'The Working Folder', kind: 'folder' },
  });
  return createHash('sha256')
    .update(__internalGetPromptText())
    .update(buildWorkspaceToolsText())
    .update(__internalGetProduceAgentToolText())
    .update(reviewCycle)
    .update(buildIncrementalReviewSection({ bindsGithub: true }))
    .update(analyzerSrc)
    .update(fencesSrc)
    .update(destinationFile)
    .update(destinationFolder)
    .digest('hex')
    .slice(0, 16);
}

describe('the distill prompt version tracks the distill prompt text', () => {
  it('declares the version the cache is keyed on', () => {
    const src = readFileSync(join(__dirname, '..', 'distill-cache.ts'), 'utf8');
    expect(src).toContain(`const DISTILL_PROMPT_VERSION = '${PROMPT_VERSION}';`);
  });

  it('records a changelog line for the current version', () => {
    // A bump with no note is how the file's history becomes unreadable.
    const src = readFileSync(join(__dirname, '..', 'distill-cache.ts'), 'utf8');
    expect(src).toMatch(new RegExp(`^// ${PROMPT_VERSION}:`, 'm'));
  });

  it('has not drifted from the text the version claims', () => {
    const actual = fingerprint();
    expect(actual).toBe(PROMPT_FINGERPRINT);
  });
});
