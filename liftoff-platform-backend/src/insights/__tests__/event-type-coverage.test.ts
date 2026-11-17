// Every billable event type is read by something a customer can see.
//
// This exists because voice was not. `voice_stt` and `voice_tts` were written to
// cost_attribution_events correctly — charged, Operating Units consumed, Stripe
// metered — and every insights provider filtered `event_type = 'llm_invocation'`
// or `'web_tool'`, so no surface could show them. An agent's line item was
// understated by exactly its voice spend, and nothing failed: not a test, not a
// type, not even the `default:` branch in buildAgentLLMMap that exists to shout
// about an unmapped purpose, because the rows never reached the switch.
//
// So the rule is written down instead of remembered. Every value in EventType is
// declared here as either read by a named provider, or deliberately not
// customer-facing with the reason. A new event type is a compile error until
// somebody decides which it is.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventType } from '../../cost-attribution/types';

/** Why an event type does not appear on a customer-facing surface. */
type NotShown = { shown: false; because: string };
/** Which provider reads it, and the file that proves the claim. */
type Shown = { shown: true; provider: string; file: string };

const COVERAGE: Record<EventType, Shown | NotShown> = {
  llm_invocation: {
    shown: true,
    provider: 'getAgentCosts / getAgentLLMCosts / getAgentlessLLMCosts',
    file: 'src/insights/data-providers/llm-usage-provider.ts',
  },
  web_tool: {
    shown: true,
    provider: 'getWebToolCosts',
    file: 'src/insights/data-providers/web-tools-cost-provider.ts',
  },
  voice_stt: {
    shown: true,
    provider: 'getAgentVoiceCosts',
    file: 'src/insights/data-providers/voice-cost-provider.ts',
  },
  voice_tts: {
    shown: true,
    provider: 'getAgentVoiceCosts',
    file: 'src/insights/data-providers/voice-cost-provider.ts',
  },

  connector_call: {
    shown: true,
    provider: 'getDataSourceCosts',
    file: 'src/insights/data-providers/data-sources-cost-provider.ts',
  },
  sandbox: {
    shown: true,
    provider: 'getSandboxCosts',
    file: 'src/insights/data-providers/sandbox-cost-provider.ts',
  },

  // Everything below is real ledger spend that is NOT broken out per agent on
  // /insights. Each needs a reason, so "we forgot" cannot masquerade as "by
  // design".
  //
  // A reason that is FALSE against the ledger is worse than the gap it covers:
  // a frozen wrong answer reads exactly like a right one, and this file is what
  // a reviewer checks instead of the data. Two plausible reasons that are false:
  //
  //   connector_call — "Composio and vendor MCP calls bill through the
  //   invocation that made them". They do not. They are standalone rows with
  //   their own customer_cost_usd and ou_consumed, and nothing folds them into
  //   an invocation.
  //
  //   sandbox — "sandbox compute is platform overhead". It is not. Every row
  //   is cost_bucket='included' and agent-attributed — a large charged line in
  //   the ledger that would be invisible on the page that exists to show it.
  //
  // So a reason is not enough on its own — `shown: false` has to say what it
  // checked. See the assertion at the bottom of this file.
  infra_compute: { shown: false, because: 'GCP infrastructure, platform overhead' },
  developer_proxy_llm: {
    shown: false,
    because: 'BYOK developer proxy has its own surface, not the workforce view',
  },
  credit: { shown: false, because: 'a correction to earlier spend, not spend of its own' },
  cloud_scheduler: { shown: false, because: 'GCP infrastructure, platform overhead' },
  kms_operation: { shown: false, because: 'GCP infrastructure, platform overhead' },
  cloud_tasks: { shown: false, because: 'GCP infrastructure, platform overhead' },
  cloud_storage_op: { shown: false, because: 'GCP infrastructure, platform overhead' },
  cloud_build: { shown: false, because: 'GCP infrastructure, platform overhead' },
};

const ROOT = join(__dirname, '..', '..', '..');

describe('every billable event type has a reader', () => {
  it('declares a decision for each one', () => {
    // The Record<EventType, …> above is the real check and it happens at compile
    // time: a new event type will not type-check until it is listed. This
    // asserts the list is not empty, so a refactor that loosened the type cannot
    // make the whole file vacuous.
    expect(Object.keys(COVERAGE).length).toBeGreaterThanOrEqual(14);
  });

  const shown = Object.entries(COVERAGE).filter(
    (entry): entry is [string, Shown] => entry[1].shown,
  );

  it.each(shown)('%s is read by a provider that actually queries it', (eventType, coverage) => {
    const source = readFileSync(join(ROOT, coverage.file), 'utf8');
    // Naming a file is not evidence. The file has to mention the event type,
    // which is what makes this fail if a provider is repointed elsewhere.
    expect(source).toContain(`'${eventType}'`);
  });

  it.each(Object.entries(COVERAGE).filter((e) => !e[1].shown))(
    '%s says why it is not customer-facing',
    (_eventType, coverage) => {
      expect((coverage as NotShown).because.length).toBeGreaterThan(10);
    },
  );

  // The two wrong reasons this file used to carry were both of one shape: a
  // claim about WHO PAYS, asserted in prose, never checked against a bucket.
  // Every remaining exemption is either infrastructure with no tenant or a
  // surface of its own, so none of them may claim a billing mechanism — if an
  // event type is exempt because of how it bills, that is a claim about the
  // ledger and it belongs in a query, not in a string.
  it.each(Object.entries(COVERAGE).filter((e) => !e[1].shown))(
    '%s does not justify itself with a billing claim',
    (_eventType, coverage) => {
      const because = (coverage as NotShown).because.toLowerCase();
      expect(because).not.toMatch(/bills? through|billed through|folded into/);
    },
  );
});
