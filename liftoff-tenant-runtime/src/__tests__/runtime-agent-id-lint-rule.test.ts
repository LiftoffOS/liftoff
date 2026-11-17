// INV-TR-010 enforcement tests.
//
// Without tests the rule can silently miss shapes such as the chat-turn
// interrupt lookup and the stop lookup, both of which can query `invocations`
// with a control-plane id and so match zero rows, turning a mid-run message
// into a 409 and a stop into a no-op. An enforcement rule with no tests of its
// own is a rule that can stop enforcing without anyone noticing.
//
// The `invalid` cases below are those two shapes, reduced. They must stay
// failing. The `valid` cases pin the false negatives that keep the rule usable:
// internal execution paths, and correctly translated call sites.

import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../eslint-rules/runtime-agent-id-must-be-resolved.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser as never,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

const untranslated = [{ messageId: 'untranslated' }];

ruleTester.run('runtime-agent-id-must-be-resolved', rule, {
  valid: [
    // Translated: the resolver's result is what reaches the query.
    `
      router.post('/:agentId/stop', async (req, res) => {
        const { tenantId, threadId } = req.body;
        const runtimeAgentId = await resolveRuntimeAgentId(tenantId, req.params.agentId);
        await pool.query(
          'SELECT id FROM invocations WHERE tenant_id = $1 AND thread_id = $2 AND agent_id = $3',
          [tenantId, threadId, runtimeAgentId],
        );
      });
    `,
    // Translated inside the helper that owns the SQL.
    `
      async function findRun(p) {
        const runtimeAgentId = await resolveRuntimeAgentId(p.tenantId, p.agentId);
        return pool.query(
          'SELECT id FROM invocations WHERE tenant_id = $1 AND agent_id = $2',
          [p.tenantId, runtimeAgentId],
        );
      }
      router.post('/:agentId/stop', async (req, res) => {
        await findRun({ tenantId: req.body.tenantId, agentId: req.params.agentId });
      });
    `,
    // Internal execution path: the id comes from execution context, never the
    // control plane. Flagging these is what made an earlier draft unusable.
    `
      async function recordUse(ctx) {
        await pool.query(
          'SELECT 1 FROM invocations WHERE tenant_id = $1 AND agent_id = $2',
          [ctx.tenantId, ctx.agentId],
        );
      }
    `,
    // tenantId/threadId also come from the request body and belong in these
    // queries; only agent-id-shaped values can land in the wrong space.
    `
      router.post('/runs', async (req, res) => {
        const { tenantId, threadId } = req.body;
        await pool.query(
          'SELECT id FROM invocations WHERE tenant_id = $1 AND thread_id = $2 AND agent_id = $3',
          [tenantId, threadId, runtimeAgentIdFromContext],
        );
      });
    `,
    // Explicit, reasoned escape hatch.
    `
      router.post('/:agentId/ticks', async (req, res) => {
        const { agentId } = req.params;
        // RUNTIME_AGENT_ID_OK: enqueued by this service with a runtime id
        await pool.query(
          'SELECT 1 FROM invocations WHERE tenant_id = $1 AND agent_id = $2',
          [req.body.tenantId, agentId],
        );
      });
    `,
    // SQL that translates in-query.
    `
      router.post('/:agentId/runs', async (req, res) => {
        const { agentId } = req.params;
        await pool.query(
          'SELECT i.id FROM invocations i JOIN internal_agent_runtime_mapping m ON m.agent_id = i.agent_id WHERE m.internal_agent_id = $1',
          [agentId],
        );
      });
    `,
  ],

  invalid: [
    // SHAPE 1 — the D12 interrupt lookup. The handler resolves the id for a
    // different purpose further down, which used to exempt the whole function.
    {
      code: `
        router.post('/:agentId/chat-turn', async (req, res) => {
          const { agentId } = req.params;
          const { tenantId, threadId } = req.body;
          const active = await pool.query(
            'SELECT id FROM invocations WHERE tenant_id = $1 AND thread_id = $2 AND agent_id = $3 AND completed_at IS NULL',
            [tenantId, threadId, agentId],
          );
          const later = await resolveRuntimeAgentId(tenantId, agentId);
          return runTurn(later, active);
        });
      `,
      errors: untranslated,
    },
    // SHAPE 2 — the stop lookup. The request-sourced id is handed to the helper
    // that owns the SQL, so nothing inside the helper mentions `req`.
    {
      code: `
        async function tryInsertAbortSignal(p) {
          const active = await pool.query(
            'SELECT id FROM invocations WHERE tenant_id = $1 AND thread_id = $2 AND agent_id = $3',
            [p.tenantId, p.threadId, p.agentId],
          );
          return active.rows.length > 0;
        }
        router.post('/:agentId/stop', async (req, res) => {
          const { tenantId, threadId } = req.body;
          await tryInsertAbortSignal({ tenantId, threadId, agentId: req.params.agentId });
        });
      `,
      errors: untranslated,
    },
    // The id reaches the query through a validator, which is how every zod
    // route in this service reads its body.
    {
      code: `
        router.post('/chat-turn', async (req, res) => {
          const parsed = ChatTurnSchema.safeParse(req.body);
          const body = parsed.data;
          await pool.query(
            'SELECT id FROM invocations WHERE tenant_id = $1 AND agent_id = $2',
            [body.tenantId, body.agentId],
          );
        });
      `,
      errors: untranslated,
    },
    // A name is not a translation: `internalAgentId` written straight into a
    // runtime-keyed column is the memories regression that started all this.
    {
      code: `
        async function loadMemories(tenantId, internalAgentId) {
          return pool.query(
            'SELECT * FROM memories WHERE tenant_id = $1 AND agent_id = $2',
            [tenantId, internalAgentId],
          );
        }
      `,
      errors: untranslated,
    },
  ],
});

// RuleTester registers its own describe/it; Jest needs a test in this file.
test('INV-TR-010 lint rule cases run', () => {
  expect(true).toBe(true);
});
