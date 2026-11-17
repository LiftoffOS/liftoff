import request from 'supertest';
import express from 'express';
import { loopRouter } from '../loop-router';
import { AutonomousLoopController } from '../loop-controller';

jest.mock('../loop-controller');
const MockCtrl = AutonomousLoopController as jest.MockedClass<typeof AutonomousLoopController>;

// Capture the module-level loopController instance before clearMocks empties MockCtrl.mock.instances.
// loop-router.ts calls `new AutonomousLoopController()` at module scope — that instance is [0].
// We use `ctrl` directly so prototype patching is not needed (auto-mock methods may be own props).
let ctrl: jest.Mocked<AutonomousLoopController>;
beforeAll(() => {
  ctrl = MockCtrl.mock.instances[0] as jest.Mocked<AutonomousLoopController>;
});

const T = '00000000-0000-0000-0000-000000000001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.ctx = { tenantId: T }; next(); });
  app.use('/agents/:agentId/loop', loopRouter);
  return app;
}

describe('POST /agents/:agentId/loop/start', () => {
  it('returns 400 for missing budgetCredits', async () => {
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/start')
      .send({ objective: 'do stuff', maxIterations: 5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing maxIterations', async () => {
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/start')
      .send({ objective: 'do stuff', budgetCredits: 50 });
    expect(res.status).toBe(400);
  });

  it('calls startLoop and returns loopId', async () => {
    ctrl.startLoop.mockResolvedValue({ id: 'loop-uuid', status: 'pending' } as any);
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/start')
      .send({ objective: 'analyse logs', maxIterations: 5, budgetCredits: 200 });
    expect(res.status).toBe(200);
    expect(res.body.loopId).toBe('loop-uuid');
    expect(ctrl.startLoop).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: T, objective: 'analyse logs', maxIterations: 5, budgetCredits: 200,
    }));
  });
});

const VALID_LOOP_UUID = '00000000-0000-4000-8000-000000000099';

describe('POST /agents/:agentId/loop/stop', () => {
  it('returns 400 for non-UUID loopId', async () => {
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/stop')
      .send({ loopId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('calls stopLoop with reason when tenant matches', async () => {
    ctrl.getLoop.mockResolvedValue({ id: VALID_LOOP_UUID, tenantId: T, status: 'running' } as any);
    ctrl.stopLoop.mockResolvedValue(undefined);
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/stop')
      .send({ loopId: VALID_LOOP_UUID, reason: 'going wrong' });
    expect(res.status).toBe(200);
    expect(ctrl.stopLoop).toHaveBeenCalledWith(VALID_LOOP_UUID, 'going wrong');
  });

  it('returns 403 when loop belongs to a different tenant', async () => {
    ctrl.getLoop.mockResolvedValue({ id: VALID_LOOP_UUID, tenantId: 'other-tenant', status: 'running' } as any);
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/stop')
      .send({ loopId: VALID_LOOP_UUID });
    expect(res.status).toBe(403);
  });

  it('returns 404 when loop does not exist', async () => {
    ctrl.getLoop.mockRejectedValue(new Error(`Loop not found: ${VALID_LOOP_UUID}`));
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/stop')
      .send({ loopId: VALID_LOOP_UUID });
    expect(res.status).toBe(404);
  });
});

describe('POST /agents/:agentId/loop/resume', () => {
  it('returns 403 when loop belongs to a different tenant', async () => {
    ctrl.getLoop.mockResolvedValue({ id: VALID_LOOP_UUID, tenantId: 'other-tenant', status: 'paused' } as any);
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/resume')
      .send({ loopId: VALID_LOOP_UUID });
    expect(res.status).toBe(403);
  });

  it('returns 404 when loop does not exist', async () => {
    ctrl.getLoop.mockRejectedValue(new Error(`Loop not found: ${VALID_LOOP_UUID}`));
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/resume')
      .send({ loopId: VALID_LOOP_UUID });
    expect(res.status).toBe(404);
  });

  it('calls resumeLoop when tenant matches', async () => {
    ctrl.getLoop.mockResolvedValue({ id: VALID_LOOP_UUID, tenantId: T, status: 'paused' } as any);
    ctrl.resumeLoop.mockResolvedValue(undefined);
    const res = await request(buildApp())
      .post('/agents/agent-1/loop/resume')
      .send({ loopId: VALID_LOOP_UUID });
    expect(res.status).toBe(200);
    expect(ctrl.resumeLoop).toHaveBeenCalledWith(VALID_LOOP_UUID);
  });
});

describe('GET /agents/:agentId/loop/status', () => {
  it('returns null when no active loop', async () => {
    ctrl.getActiveLoop.mockResolvedValue(null);
    const res = await request(buildApp())
      .get(`/agents/agent-1/loop/status?tenantId=${T}`);
    expect(res.status).toBe(200);
    expect(res.body.loop).toBeNull();
  });
});
