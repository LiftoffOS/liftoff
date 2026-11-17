// Fitness function: the compiled prompt never reaches a browser.
//
// `systemPrompt`, `userInstructions` and `instructionsMd` are what the
// distiller produces — the agent itself. They stay on `InternalAgent` because
// server-side callers genuinely need them (version snapshots, the reconciler,
// the Pub/Sub payload the tenant runtime executes from, the service-auth _svc
// routes), so the redaction happens at the response boundary instead. That
// makes it something a future call site can forget, which is what this pins.
//
// Before the change, `GET /api/internal-agents` returned every agent's compiled
// prompt in one call and `GET /:id/versions` returned an agent's entire
// prompt-evolution history. Nothing in the app has ever rendered any of it.

import { toClientAgent, toClientAgents, toClientVersion } from '../row-mapper';

const WITHHELD = ['systemPrompt', 'userInstructions', 'instructionsMd'] as const;

const agent = {
  id: 'agent-1',
  tenantId: 'tenant-1',
  role: 'Support Engineer',
  responsibilities: 'Answer inbound tickets.',
  additionalContext: 'Escalate billing questions.',
  summary: 'Handles support.',
  systemPrompt: 'You are a support engineer. Never promise a refund.',
  userInstructions: 'Start by classifying the ticket.',
  instructionsMd: '# Project guide\nUse the runbook.',
  skills: [{ name: 'triage', instruction: 'Sort by severity.' }],
  status: 'active',
  temperature: 0.3,
};

describe('toClientAgent', () => {
  it('withholds every generated prompt field', () => {
    const client = toClientAgent(agent) as Record<string, unknown>;
    for (const field of WITHHELD) {
      expect(client).not.toHaveProperty(field);
    }
  });

  it('keeps everything else, including the inputs the update page edits', () => {
    const client = toClientAgent(agent) as Record<string, unknown>;
    expect(client.id).toBe('agent-1');
    expect(client.role).toBe('Support Engineer');
    // The prose the person authored is theirs and stays: the update page
    // renders these for editing, and they are the distiller's input rather
    // than its output.
    expect(client.responsibilities).toBe('Answer inbound tickets.');
    expect(client.additionalContext).toBe('Escalate billing questions.');
    expect(client.summary).toBe('Handles support.');
    expect(client.temperature).toBe(0.3);
  });

  it('keeps per-skill instructions, which the skills editor prefills', () => {
    // Distilled prose, but user-editable and rendered in a textarea. Stripping
    // it would blank that box and let a save overwrite the real instruction.
    const client = toClientAgent(agent) as Record<string, unknown>;
    expect(client.skills).toEqual([{ name: 'triage', instruction: 'Sort by severity.' }]);
  });

  it('does not mutate its input, so server-side callers keep the prompt', () => {
    const original = { ...agent };
    toClientAgent(agent);
    expect(agent).toEqual(original);
    expect(agent.systemPrompt).toBe('You are a support engineer. Never promise a refund.');
  });

  it('tolerates an agent that never had the fields', () => {
    const bare = { id: 'a', role: 'r' };
    expect(toClientAgent(bare)).toEqual({ id: 'a', role: 'r' });
  });
});

describe('toClientAgents', () => {
  it('redacts every element, which is what the list endpoint depends on', () => {
    const clients = toClientAgents([agent, { ...agent, id: 'agent-2' }]) as Record<string, unknown>[];
    expect(clients).toHaveLength(2);
    for (const client of clients) {
      for (const field of WITHHELD) {
        expect(client).not.toHaveProperty(field);
      }
    }
  });
});

describe('toClientVersion', () => {
  it('withholds the prompt from a version snapshot', () => {
    const version = {
      id: 'v-1',
      internalAgentId: 'agent-1',
      version: 3,
      role: 'Support Engineer',
      responsibilities: 'Answer inbound tickets.',
      systemPrompt: 'You are a support engineer.',
      userInstructions: 'Classify first.',
      instructionsMd: null,
      source: 'distill',
      createdAt: new Date(0),
    };
    const client = toClientVersion(version) as Record<string, unknown>;
    for (const field of WITHHELD) {
      expect(client).not.toHaveProperty(field);
    }
    // What RollbackModal actually reads.
    expect(client.version).toBe(3);
    expect(client.createdAt).toEqual(new Date(0));
  });
});
