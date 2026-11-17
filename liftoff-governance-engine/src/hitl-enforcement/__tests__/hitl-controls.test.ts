// Comprehensive HITL Controls Test Suite
//
// Covers every control available on the /oversight page:
//   - All 5 HITL levels (1 = full gate → 5 = fully autonomous)
//   - All 3 autonomy settings (controlled/balanced/autonomous) and their level mappings
//   - All 3 escalation settings (exceptions/important/sensitive) and how they affect gating
//   - All 5 sensitive work categories individually (on/off toggle)
//   - Communication modes (draft/auto/review) — stored in cache, runtime gating covered
//   - Super-destructive operations gate at ALL levels
//   - Rate limiting at levels 4 and 5
//   - HITL level resolution (tenant cache + team override)

import {
  ToolCallRequest,
  ModelTool,
  OversightSettings,
  SUPER_DESTRUCTIVE_OPERATIONS,
} from '../types';
import { HitlEnforcementService } from '../service';
import { pool } from '../../infrastructure/database';
import { insertAuditLog } from '../../audit/service';

jest.mock('../../infrastructure/database');
jest.mock('../../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../events/publisher', () => ({
  publishCorrectionCaptured: jest.fn().mockResolvedValue(undefined),
  publishLateFeedbackFlagged: jest.fn().mockResolvedValue(undefined),
  publishActionCompensated: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: {
    onLateFeedbackFlagged: jest.fn().mockResolvedValue(undefined),
    onActionCompensated: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockPool = pool as jest.Mocked<typeof pool>;
const mockInsertAuditLog = insertAuditLog as jest.MockedFunction<typeof insertAuditLog>;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-controls-test';

// Tool library — one per relevant category + destructive variants
const TOOL_LIBRARY: ModelTool[] = [
  // Non-destructive, uncategorised (safe)
  { name: 'search_web', description: 'Search the web', categories: [] },
  { name: 'read_file', description: 'Read a file', categories: [] },
  // Sensitive categories
  { name: 'send_email', description: 'Send email to customer', categories: ['customerCommunication'] },
  { name: 'post_to_slack', description: 'Post a Slack message', categories: ['customerCommunication', 'externalPublishing'] },
  { name: 'create_stripe_charge', description: 'Charge a customer', categories: ['financialActions'] },
  { name: 'update_crm_record', description: 'Update CRM record', categories: ['dataChanges'] },
  { name: 'publish_job_offer', description: 'Publish a job offer', categories: ['externalPublishing'] },
  { name: 'send_offer_letter', description: 'Send offer letter', categories: ['hiringDecisions'] },
  // Destructive (⚠️ marker, not in SUPER_DESTRUCTIVE_OPERATIONS)
  { name: 'delete_record', description: '⚠️ DESTRUCTIVE: Delete a database record', categories: [] },
  { name: 'truncate_table', description: '⚠️ DESTRUCTIVE: Truncate a table' },
  // Unclassified (no categories property)
  { name: 'custom_mcp_tool', description: 'A custom MCP tool' },
];

function toolCall(name: string, input: Record<string, unknown> = {}): ToolCallRequest {
  return { id: `tc-${name}`, name, input };
}

// Full oversight with all sensitive categories enabled, escalation=sensitive
const OVERSIGHT_ALL_ON: OversightSettings = {
  tenantId: TENANT_ID,
  autonomy: 'balanced',
  escalation: 'sensitive',
  sensitiveWork: {
    customerCommunication: true,
    financialActions: true,
    dataChanges: true,
    externalPublishing: true,
    hiringDecisions: true,
  },
  communication: 'review',
};

// Oversight with escalation=exceptions (no sensitive work gating)
const OVERSIGHT_EXCEPTIONS: OversightSettings = {
  ...OVERSIGHT_ALL_ON,
  escalation: 'exceptions',
};

// ---------------------------------------------------------------------------
// Suite 1: HITL Level Enforcement
// ---------------------------------------------------------------------------

describe('HITL Level 1 — Full Gate (all tool calls require approval)', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('gates a safe non-destructive tool', async () => {
    const result = await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_ALL_ON, 1, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'level_1_gate' });
  });

  it('gates a destructive tool', async () => {
    const result = await svc.checkHitlGate([toolCall('delete_record')], OVERSIGHT_ALL_ON, 1, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true });
  });

  it('gates a communication tool', async () => {
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_ALL_ON, 1, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true });
  });

  it('gates a financial tool', async () => {
    const result = await svc.checkHitlGate([toolCall('create_stripe_charge')], OVERSIGHT_ALL_ON, 1, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true });
  });

  it('still gates even when escalation=exceptions', async () => {
    const result = await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_EXCEPTIONS, 1, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'level_1_gate' });
  });

  it('does not gate empty tool calls', async () => {
    const result = await svc.checkHitlGate([], OVERSIGHT_ALL_ON, 1, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });
});

describe('HITL Level 2 — Destructive Gate (controlled autonomy)', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('allows a safe non-destructive tool when escalation=exceptions', async () => {
    const result = await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_EXCEPTIONS, 2, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('allows an unclassified custom tool when escalation=exceptions', async () => {
    const result = await svc.checkHitlGate([toolCall('custom_mcp_tool')], OVERSIGHT_EXCEPTIONS, 2, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('gates a tool with ⚠️ DESTRUCTIVE marker', async () => {
    const result = await svc.checkHitlGate([toolCall('delete_record')], OVERSIGHT_EXCEPTIONS, 2, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'destructive_gate' });
  });

  it('gates a table truncation (⚠️ DESTRUCTIVE marker, no categories)', async () => {
    const result = await svc.checkHitlGate([toolCall('truncate_table')], OVERSIGHT_EXCEPTIONS, 2, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'destructive_gate' });
  });

  it('does NOT gate sensitive work tools when escalation=exceptions (only destructive matters at L2)', async () => {
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_EXCEPTIONS, 2, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('gates sensitive work tools when escalation=sensitive and category enabled', async () => {
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_ALL_ON, 2, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
  });

  it('does not gate a destructive tool if the marker casing is wrong (case-sensitive)', async () => {
    const lowercaseTool: ModelTool[] = [
      { name: 'soft_del', description: '⚠️ destructive: soft delete', categories: [] },
    ];
    const result = await svc.checkHitlGate([toolCall('soft_del')], OVERSIGHT_EXCEPTIONS, 2, lowercaseTool, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('gates when a mix of safe and destructive tools are submitted together', async () => {
    const result = await svc.checkHitlGate(
      [toolCall('search_web'), toolCall('delete_record')],
      OVERSIGHT_EXCEPTIONS, 2, TOOL_LIBRARY, TENANT_ID,
    );
    expect(result).toMatchObject({ shouldGate: true, reason: 'destructive_gate' });
  });
});

describe('HITL Level 3 — Balanced (sensitive work gating)', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('allows safe non-destructive tools', async () => {
    const result = await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_EXCEPTIONS, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('allows destructive tools (⚠️ marker — not gated at L3)', async () => {
    const result = await svc.checkHitlGate([toolCall('delete_record')], OVERSIGHT_EXCEPTIONS, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('gates customerCommunication tool when category enabled and escalation=sensitive', async () => {
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_ALL_ON, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
  });

  it('gates financialActions tool when category enabled', async () => {
    const result = await svc.checkHitlGate([toolCall('create_stripe_charge')], OVERSIGHT_ALL_ON, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'financialActions' });
  });

  it('gates dataChanges tool when category enabled', async () => {
    const result = await svc.checkHitlGate([toolCall('update_crm_record')], OVERSIGHT_ALL_ON, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'dataChanges' });
  });

  it('gates externalPublishing tool when category enabled', async () => {
    const result = await svc.checkHitlGate([toolCall('publish_job_offer')], OVERSIGHT_ALL_ON, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'externalPublishing' });
  });

  it('gates hiringDecisions tool when category enabled', async () => {
    const result = await svc.checkHitlGate([toolCall('send_offer_letter')], OVERSIGHT_ALL_ON, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'hiringDecisions' });
  });

  it('does NOT gate when escalation=exceptions (even with all categories on)', async () => {
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_EXCEPTIONS, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('does NOT gate when escalation=important but category is disabled', async () => {
    const oversight: OversightSettings = {
      ...OVERSIGHT_ALL_ON,
      escalation: 'important',
      sensitiveWork: { ...OVERSIGHT_ALL_ON.sensitiveWork, customerCommunication: false },
    };
    const result = await svc.checkHitlGate([toolCall('send_email')], oversight, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });
});

describe('HITL Level 4 — Smart Autonomous (auto-elevation)', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('auto-elevates low-risk tools (empty categories, no destructive marker) — no gate', async () => {
    const result = await svc.checkHitlGate(
      [toolCall('search_web'), toolCall('read_file')],
      OVERSIGHT_ALL_ON, 4, TOOL_LIBRARY, TENANT_ID,
    );
    expect(result.shouldGate).toBe(false);
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID, expect.objectContaining({
      action: 'search_web',
      inputArgs: expect.objectContaining({ hitlLevel: 4, autoElevated: true }),
      outcome: 'success',
    }));
  });

  it('does NOT auto-elevate tools with sensitive categories — falls to sensitive work check', async () => {
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_ALL_ON, 4, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID, expect.objectContaining({
      action: 'send_email',
      inputArgs: expect.objectContaining({ gated: true, reason: 'sensitive_work' }),
      outcome: 'gated',
    }));
  });

  it('does NOT auto-elevate tools with sensitive categories when category disabled — passes without auto-elevate audit', async () => {
    const oversight: OversightSettings = {
      ...OVERSIGHT_ALL_ON,
      sensitiveWork: { ...OVERSIGHT_ALL_ON.sensitiveWork, customerCommunication: false },
    };
    const result = await svc.checkHitlGate([toolCall('send_email')], oversight, 4, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
    // Tool has categories so not auto-elevated, but passes — logged at catch-all with autoElevated: false
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID, expect.objectContaining({
      action: 'send_email',
      inputArgs: expect.objectContaining({ hitlLevel: 4, autoElevated: false }),
      outcome: 'success',
    }));
  });

  it('does NOT auto-elevate unclassified tools (categories undefined)', async () => {
    const result = await svc.checkHitlGate([toolCall('custom_mcp_tool')], OVERSIGHT_EXCEPTIONS, 4, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
    // Unclassified tool passes at catch-all with autoElevated: false
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID, expect.objectContaining({
      action: 'custom_mcp_tool',
      inputArgs: expect.objectContaining({ hitlLevel: 4, autoElevated: false }),
      outcome: 'success',
    }));
  });

  it('mixed batch: one high-risk tool prevents auto-elevation of the whole batch', async () => {
    const result = await svc.checkHitlGate(
      [toolCall('search_web'), toolCall('send_email')],  // low-risk + high-risk
      OVERSIGHT_ALL_ON, 4, TOOL_LIBRARY, TENANT_ID,
    );
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
    // Both tools get gated audit records
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID, expect.objectContaining({
      action: 'send_email',
      inputArgs: expect.objectContaining({ gated: true, reason: 'sensitive_work' }),
      outcome: 'gated',
    }));
  });

  it('gates at rate limit even for low-risk tools', async () => {
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '1001' }] });
    const result = await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_ALL_ON, 4, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'rate_limit_exceeded' });
  });

  it('super-destructive always gates, checked before level logic', async () => {
    const sdTool = [...SUPER_DESTRUCTIVE_OPERATIONS][0];
    const result = await svc.checkHitlGate([{ id: 'tc-sd', name: sdTool, input: {} }], OVERSIGHT_ALL_ON, 4, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'super_destructive_gate' });
  });
});

describe('HITL Level 5 — Fully Autonomous', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('allows any tool including destructive ones', async () => {
    const result = await svc.checkHitlGate([toolCall('delete_record')], OVERSIGHT_ALL_ON, 5, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('allows all sensitive work tools even with escalation=sensitive and all categories on', async () => {
    for (const tool of ['send_email', 'create_stripe_charge', 'update_crm_record', 'publish_job_offer', 'send_offer_letter']) {
      jest.clearAllMocks();
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
      const result = await svc.checkHitlGate([toolCall(tool)], OVERSIGHT_ALL_ON, 5, TOOL_LIBRARY, TENANT_ID);
      expect(result.shouldGate).toBe(false);
    }
  });

  it('still gates super-destructive operations', async () => {
    for (const sdOp of SUPER_DESTRUCTIVE_OPERATIONS) {
      const result = await svc.checkHitlGate([{ id: 'sd', name: sdOp, input: {} }], OVERSIGHT_ALL_ON, 5, TOOL_LIBRARY, TENANT_ID);
      expect(result).toMatchObject({ shouldGate: true, reason: 'super_destructive_gate' });
    }
  });

  it('gates at rate limit', async () => {
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '1001' }] });
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_ALL_ON, 5, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'rate_limit_exceeded' });
  });

  it('logs audit entry for each tool call with actual tool name', async () => {
    await svc.checkHitlGate(
      [toolCall('send_email'), toolCall('create_stripe_charge')],
      OVERSIGHT_ALL_ON, 5, TOOL_LIBRARY, TENANT_ID,
    );
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT_ID, expect.objectContaining({
      action: 'send_email',
      inputArgs: expect.objectContaining({ hitlLevel: 5, autoElevated: false }),
      outcome: 'success',
      triggeredBy: 'system',
    }));
  });
});

describe('Super-destructive operations gate at ALL HITL levels', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  for (const sdOp of SUPER_DESTRUCTIVE_OPERATIONS) {
    it(`${sdOp} is gated at all levels`, async () => {
      for (const level of [1, 2, 3, 4, 5]) {
        const result = await svc.checkHitlGate(
          [{ id: 'sd', name: sdOp, input: {} }],
          OVERSIGHT_ALL_ON, level, TOOL_LIBRARY, TENANT_ID,
        );
        expect(result).toMatchObject({ shouldGate: true, reason: 'super_destructive_gate' });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 2: Sensitive Work Category Toggles
// ---------------------------------------------------------------------------

describe('Sensitive work category toggles', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  const BASE_OVERSIGHT: OversightSettings = {
    tenantId: TENANT_ID,
    autonomy: 'balanced',
    escalation: 'sensitive',
    sensitiveWork: {
      customerCommunication: false,
      financialActions: false,
      dataChanges: false,
      externalPublishing: false,
      hiringDecisions: false,
    },
    communication: 'review',
  };

  const CATEGORY_TOOL_MAP: Array<{ category: keyof OversightSettings['sensitiveWork']; toolName: string }> = [
    { category: 'customerCommunication', toolName: 'send_email' },
    { category: 'financialActions', toolName: 'create_stripe_charge' },
    { category: 'dataChanges', toolName: 'update_crm_record' },
    { category: 'externalPublishing', toolName: 'publish_job_offer' },
    { category: 'hiringDecisions', toolName: 'send_offer_letter' },
  ];

  for (const { category, toolName } of CATEGORY_TOOL_MAP) {
    describe(`${category}`, () => {
      it(`passes when ${category}=false`, async () => {
        const oversight = { ...BASE_OVERSIGHT, sensitiveWork: { ...BASE_OVERSIGHT.sensitiveWork } };
        const result = await svc.checkHitlGate([toolCall(toolName)], oversight, 3, TOOL_LIBRARY, TENANT_ID);
        expect(result.shouldGate).toBe(false);
      });

      it(`gates when ${category}=true (escalation=sensitive, L3)`, async () => {
        const oversight: OversightSettings = {
          ...BASE_OVERSIGHT,
          sensitiveWork: { ...BASE_OVERSIGHT.sensitiveWork, [category]: true },
        };
        const result = await svc.checkHitlGate([toolCall(toolName)], oversight, 3, TOOL_LIBRARY, TENANT_ID);
        expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work', matchedCategory: category });
      });

      it(`gates when ${category}=true and escalation=important`, async () => {
        const oversight: OversightSettings = {
          ...BASE_OVERSIGHT,
          escalation: 'important',
          sensitiveWork: { ...BASE_OVERSIGHT.sensitiveWork, [category]: true },
        };
        const result = await svc.checkHitlGate([toolCall(toolName)], oversight, 3, TOOL_LIBRARY, TENANT_ID);
        expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
      });

      it(`does NOT gate when ${category}=true but escalation=exceptions`, async () => {
        const oversight: OversightSettings = {
          ...BASE_OVERSIGHT,
          escalation: 'exceptions',
          sensitiveWork: { ...BASE_OVERSIGHT.sensitiveWork, [category]: true },
        };
        const result = await svc.checkHitlGate([toolCall(toolName)], oversight, 3, TOOL_LIBRARY, TENANT_ID);
        expect(result.shouldGate).toBe(false);
      });

      it(`enabling only ${category} does not gate other categories`, async () => {
        const OTHER_TOOLS = CATEGORY_TOOL_MAP
          .filter(m => m.category !== category)
          .map(m => toolCall(m.toolName));

        if (OTHER_TOOLS.length === 0) return;

        const oversight: OversightSettings = {
          ...BASE_OVERSIGHT,
          sensitiveWork: { ...BASE_OVERSIGHT.sensitiveWork, [category]: true },
        };

        for (const otherCall of OTHER_TOOLS) {
          jest.clearAllMocks();
          (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
          const result = await svc.checkHitlGate([otherCall], oversight, 3, TOOL_LIBRARY, TENANT_ID);
          expect(result.shouldGate).toBe(false);
        }
      });
    });
  }

  it('a tool with multiple categories gates on the first matching enabled category', async () => {
    // post_to_slack has ['customerCommunication', 'externalPublishing']
    const oversight: OversightSettings = {
      ...BASE_OVERSIGHT,
      sensitiveWork: { ...BASE_OVERSIGHT.sensitiveWork, externalPublishing: true },
    };
    const result = await svc.checkHitlGate([toolCall('post_to_slack')], oversight, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Escalation Level Behaviour
// ---------------------------------------------------------------------------

describe('Escalation level settings', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('escalation=exceptions — no sensitive work gating regardless of categories', async () => {
    for (const tool of ['send_email', 'create_stripe_charge', 'update_crm_record', 'publish_job_offer', 'send_offer_letter']) {
      jest.clearAllMocks();
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
      const result = await svc.checkHitlGate([toolCall(tool)], OVERSIGHT_EXCEPTIONS, 3, TOOL_LIBRARY, TENANT_ID);
      expect(result.shouldGate).toBe(false);
    }
  });

  it('escalation=important — sensitive work gating applies (same as sensitive in current impl)', async () => {
    const oversight: OversightSettings = { ...OVERSIGHT_ALL_ON, escalation: 'important' };
    const result = await svc.checkHitlGate([toolCall('send_email')], oversight, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
  });

  it('escalation=sensitive — sensitive work gating applies', async () => {
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_ALL_ON, 3, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
  });

  it('escalation=exceptions still allows level_1_gate to fire (level check precedes escalation)', async () => {
    const result = await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_EXCEPTIONS, 1, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'level_1_gate' });
  });

  it('escalation=exceptions still allows super_destructive_gate to fire', async () => {
    const sdOp = [...SUPER_DESTRUCTIVE_OPERATIONS][0];
    const result = await svc.checkHitlGate([{ id: 'sd', name: sdOp, input: {} }], OVERSIGHT_EXCEPTIONS, 5, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'super_destructive_gate' });
  });
});

// ---------------------------------------------------------------------------
// Suite 4: HITL Level Resolution (autonomy → level mapping + team override)
// ---------------------------------------------------------------------------

describe('resolveHitlLevel — autonomy → HITL level mapping', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('controlled → level 2', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ tenant_id: TENANT_ID, autonomy: 'controlled', escalation: 'sensitive', sensitive_work: {}, communication: 'review' }],
    });
    const level = await svc.resolveHitlLevel(TENANT_ID);
    expect(level).toBe(2);
  });

  it('balanced → level 3', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ tenant_id: TENANT_ID, autonomy: 'balanced', escalation: 'sensitive', sensitive_work: {}, communication: 'review' }],
    });
    const level = await svc.resolveHitlLevel(TENANT_ID);
    expect(level).toBe(3);
  });

  it('autonomous → level 4', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ tenant_id: TENANT_ID, autonomy: 'autonomous', escalation: 'sensitive', sensitive_work: {}, communication: 'review' }],
    });
    const level = await svc.resolveHitlLevel(TENANT_ID);
    expect(level).toBe(4);
  });

  it('no cache entry → defaults to balanced → level 3', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const level = await svc.resolveHitlLevel(TENANT_ID);
    expect(level).toBe(3);
  });

  it('team override takes precedence over tenant cache', async () => {
    // Even if tenant cache says 'autonomous' (L4), team override of 2 wins
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ tenant_id: TENANT_ID, autonomy: 'autonomous', escalation: 'sensitive', sensitive_work: {}, communication: 'review' }],
    });
    const level = await svc.resolveHitlLevel(TENANT_ID, 2);
    expect(level).toBe(2);
    // Should not hit the DB when team override provided
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('team override of 1 enforces strictest gating regardless of tenant setting', async () => {
    const level = await svc.resolveHitlLevel(TENANT_ID, 1);
    expect(level).toBe(1);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('team override of 5 enforces fully autonomous regardless of tenant setting', async () => {
    const level = await svc.resolveHitlLevel(TENANT_ID, 5);
    expect(level).toBe(5);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('getDefaultHitlLevel — direct mapping', () => {
  let svc: HitlEnforcementService;
  beforeEach(() => { svc = new HitlEnforcementService(); });

  it.each([
    ['controlled', 2],
    ['balanced', 3],
    ['autonomous', 4],
    ['unknown_value', 3],  // defaults to balanced
    ['', 3],
  ])('autonomy=%s → level %i', (autonomy, expected) => {
    expect(svc.getDefaultHitlLevel(autonomy)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Rate limiting boundary conditions
// ---------------------------------------------------------------------------

describe('Rate limiting (levels 4 and 5)', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('L5: exactly at limit (1000) — allowed', async () => {
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '1000' }] });
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_ALL_ON, 5, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('L5: one over limit (1001) — gated', async () => {
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '1001' }] });
    const result = await svc.checkHitlGate([toolCall('send_email')], OVERSIGHT_ALL_ON, 5, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'rate_limit_exceeded' });
    expect(result.message).toContain('1001');
    expect(result.message).toContain('1000');
  });

  it('L4 auto-elevated: exactly at limit (1000) — allowed', async () => {
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '1000' }] });
    const result = await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_ALL_ON, 4, TOOL_LIBRARY, TENANT_ID);
    expect(result.shouldGate).toBe(false);
  });

  it('L4 auto-elevated: over limit — gated', async () => {
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '1500' }] });
    const result = await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_ALL_ON, 4, TOOL_LIBRARY, TENANT_ID);
    expect(result).toMatchObject({ shouldGate: true, reason: 'rate_limit_exceeded' });
  });

  it('rate limit is not checked at L1/L2/L3 (those levels gate before reaching rate check)', async () => {
    // L1 gates immediately with level_1_gate, never queries rate limit
    await svc.checkHitlGate([toolCall('search_web')], OVERSIGHT_ALL_ON, 1, TOOL_LIBRARY, TENANT_ID);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Communication mode stored in cache (not a gating factor at service layer)
// ---------------------------------------------------------------------------

describe('Communication mode is stored in oversight cache but does not affect HITL gating directly', () => {
  let svc: HitlEnforcementService;

  beforeEach(() => {
    svc = new HitlEnforcementService();
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it.each(['draft', 'auto', 'review'] as const)(
    'communication=%s does not change gating result at L3 with sensitive categories',
    async (communication) => {
      const oversight: OversightSettings = { ...OVERSIGHT_ALL_ON, communication };
      const result = await svc.checkHitlGate([toolCall('send_email')], oversight, 3, TOOL_LIBRARY, TENANT_ID);
      // Gating is determined by hitlLevel + sensitiveWork, not communication mode
      expect(result).toMatchObject({ shouldGate: true, reason: 'sensitive_work' });
    },
  );

  it.each(['draft', 'auto', 'review'] as const)(
    'communication=%s does not unblock a safe tool at L3',
    async (communication) => {
      const oversight: OversightSettings = { ...OVERSIGHT_EXCEPTIONS, communication };
      const result = await svc.checkHitlGate([toolCall('search_web')], oversight, 3, TOOL_LIBRARY, TENANT_ID);
      expect(result.shouldGate).toBe(false);
    },
  );
});
