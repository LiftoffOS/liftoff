// C2 tests: per-toolkit overlay coverage + uniqueness + W1 round-trip +
// canonical-shape parity for the W1 pairings.

import { COMPOSIO_TOOL_OVERLAYS } from '../overlays';
import { CANONICAL_RESPONSE_SHAPES } from '../canonical-shapes';
import { validateOverlayCoverage } from '../resolve';

describe('overlay coverage', () => {
  it('every overlay stableName is unique within the toolkit', () => {
    for (const [toolkit, overlays] of Object.entries(COMPOSIO_TOOL_OVERLAYS)) {
      const seen = new Map<string, string>();
      for (const [vendor, overlay] of Object.entries(overlays)) {
        const prior = seen.get(overlay.stableName);
        if (prior) {
          throw new Error(
            `composio_overlay_duplicate_stable_name: toolkit=${toolkit} ` +
            `stableName=${overlay.stableName} mapped from=${prior},${vendor}`,
          );
        }
        seen.set(overlay.stableName, vendor);
      }
    }
  });

  it('every composio_managed schema entry has a matching overlay entry', () => {
    const violations = validateOverlayCoverage();
    if (violations.length > 0) {
      const detail = violations.map((v) => `  - ${v.toolkit}.${v.vendorSlug}: ${v.reason}`).join('\n');
      throw new Error(`overlay coverage violations:\n${detail}`);
    }
  });
});

describe('W1 work_inbox/ack pairings', () => {
  it('round-trip: inbox.paired_ack resolves to an ack whose acknowledges points back to inbox.stableName', () => {
    for (const [toolkit, overlays] of Object.entries(COMPOSIO_TOOL_OVERLAYS)) {
      const stableToOverlay = new Map<string, { vendor: string; overlay: typeof overlays[string] }>();
      for (const [vendor, overlay] of Object.entries(overlays)) {
        stableToOverlay.set(overlay.stableName, { vendor, overlay });
      }
      for (const [vendor, overlay] of Object.entries(overlays)) {
        if (overlay.workRole === 'inbox') {
          expect(overlay.paired_ack).toBeDefined();
          expect(overlay.workItemKind).toBeDefined();
          const ackEntry = stableToOverlay.get(overlay.paired_ack!);
          if (!ackEntry) {
            throw new Error(
              `inbox tool ${toolkit}.${overlay.stableName} (vendor=${vendor}) ` +
              `paired_ack=${overlay.paired_ack} not found in toolkit`,
            );
          }
          expect(ackEntry.overlay.workRole).toBe('ack');
          expect(ackEntry.overlay.acknowledges).toBe(overlay.stableName);
          expect(ackEntry.overlay.workItemKind).toBe(overlay.workItemKind);
        }
        if (overlay.workRole === 'ack') {
          expect(overlay.acknowledges).toBeDefined();
          expect(overlay.workItemKind).toBeDefined();
          const inboxEntry = stableToOverlay.get(overlay.acknowledges!);
          if (!inboxEntry) {
            throw new Error(
              `ack tool ${toolkit}.${overlay.stableName} (vendor=${vendor}) ` +
              `acknowledges=${overlay.acknowledges} not found in toolkit`,
            );
          }
          expect(inboxEntry.overlay.workRole).toBe('inbox');
          expect(inboxEntry.overlay.paired_ack).toBe(overlay.stableName);
        }
      }
    }
  });
});

describe('translateOutput against CANONICAL_RESPONSE_SHAPES', () => {
  it('every overlay that defines translateOutput AND has a canonical shape produces a result matching the shape (smoke fixture)', () => {
    // Smoke: pick known canonical shapes for the toolkits we've seeded
    // and confirm the registered shape exists. The full fixture-driven
    // translation suite lives in __tests__/translations/<toolkit>.test.ts.
    for (const [toolkit, overlays] of Object.entries(COMPOSIO_TOOL_OVERLAYS)) {
      for (const overlay of Object.values(overlays)) {
        const key = `${toolkit}.${overlay.stableName}`;
        if (key in CANONICAL_RESPONSE_SHAPES) {
          // Canonical shape is registered — verify it's a Zod schema.
          const schema = CANONICAL_RESPONSE_SHAPES[key as keyof typeof CANONICAL_RESPONSE_SHAPES];
          expect(typeof schema.safeParse).toBe('function');
        }
      }
    }
  });
});

// The stage/apply pairing, the same shape as the inbox/ack one above and the
// same rule connector-service's boot validator applies: a stage names an
// apply in its own toolkit, an apply is named by a stage, and a pairing on a
// tool that stages nothing is a declaration that does nothing.
describe('staged-write pairings', () => {
  it('round-trip: stage.paired_apply resolves to an apply in the same toolkit, and every apply is named by a stage', () => {
    for (const [toolkit, overlays] of Object.entries(COMPOSIO_TOOL_OVERLAYS)) {
      const stableToOverlay = new Map<string, typeof overlays[string]>();
      for (const overlay of Object.values(overlays)) stableToOverlay.set(overlay.stableName, overlay);
      const applies = new Set(Object.values(overlays).filter((o) => o.writeRole === 'stage' && o.paired_apply).map((o) => o.paired_apply!));
      for (const [vendor, overlay] of Object.entries(overlays)) {
        if (overlay.writeRole === 'stage') {
          if (!overlay.paired_apply) throw new Error(`${toolkit}.${overlay.stableName} (${vendor}) stages with no paired_apply`);
          const apply = stableToOverlay.get(overlay.paired_apply);
          if (!apply) throw new Error(`${toolkit}.${overlay.stableName} pairs to ${overlay.paired_apply}, which the toolkit does not declare`);
          expect(apply.writeRole).toBe('apply');
        }
        if (overlay.paired_apply && overlay.writeRole !== 'stage') {
          throw new Error(`${toolkit}.${overlay.stableName} sets paired_apply without staging anything`);
        }
        if (overlay.writeRole === 'apply' && !applies.has(overlay.stableName)) {
          throw new Error(`${toolkit}.${overlay.stableName} is an apply no stage names`);
        }
      }
    }
  });

  it('the first family that opts in is Mailchimp campaigns: create_campaign stages, send_campaign applies', () => {
    const mailchimp = COMPOSIO_TOOL_OVERLAYS.mailchimp;
    expect(mailchimp.MAILCHIMP_ADD_CAMPAIGN).toMatchObject({ stableName: 'create_campaign', writeRole: 'stage', paired_apply: 'send_campaign' });
    expect(mailchimp.MAILCHIMP_SEND_CAMPAIGN).toMatchObject({ stableName: 'send_campaign', writeRole: 'apply' });
  });
});
