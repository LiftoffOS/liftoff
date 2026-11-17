// Regression: title-generation purpose must round-trip through workforce-
// service's single-turn complete() into the platform-backend usageContext,
// so /insights buckets the cost under caio_workforce_planning_title_generation
// rather than the legacy 'title_generation' bucket.

import { resetConfigForTests } from '../infrastructure/config.js';

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'http://pb.local';
  process.env['GCP_PROJECT_ID'] = 'test';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:r:i';
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ content: 'Title result', model: 'apollo', provider: 'liftoff' }),
    text: async () => '',
  } as unknown as Response);
});

afterEach(() => fetchSpy.mockRestore());

describe('single-turn complete() purpose pass-through', () => {
  it('forwards a caller-supplied purpose into usageContext (caio_workforce_planning_title_generation)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { complete } = require('../llm/client.js');
    await complete({
      systemPrompt: 'sys',
      userContent: 'user',
      tier: 'small',
      maxTokens: 80,
      purpose: 'caio_workforce_planning_title_generation',
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.usageContext).toEqual({
      purpose: 'caio_workforce_planning_title_generation',
    });
  });

  it('defaults to caio_workforce_planning when caller omits purpose (NOT the legacy "title_generation" bucket)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { complete } = require('../llm/client.js');
    await complete({
      systemPrompt: 'sys',
      userContent: 'user',
      tier: 'small',
      maxTokens: 80,
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.usageContext.purpose).toBe('caio_workforce_planning');
    expect(body.usageContext.purpose).not.toBe('title_generation');
  });
});
