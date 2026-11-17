// Content Indexer Tests

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
  withTenantScope: jest.fn(),
}));
jest.mock('../../memory/embedding', () => ({
  generateEmbeddingsBatch: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockByAlias = jest.fn();
const mockById = jest.fn();
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifestByAlias: (...a: unknown[]) => mockByAlias(...a),
    getById: (...a: unknown[]) => mockById(...a),
  },
}));

import { contentIndexer } from '../content-indexer';
import { getPool, withTenantScope } from '../../infrastructure/database';
import { generateEmbeddingsBatch } from '../../memory/embedding';

const mockQuery = jest.fn();
const mockPool = { query: mockQuery };

beforeEach(() => {
  (getPool as jest.Mock).mockReturnValue(mockPool);
  // connector_content is FORCE RLS (372): the writer runs inside a scope.
  (withTenantScope as jest.Mock).mockImplementation(
    (_tenantId: string, fn: (c: unknown) => Promise<unknown>) => fn(mockPool),
  );
  (generateEmbeddingsBatch as jest.Mock).mockResolvedValue([[0.1, 0.2, 0.3]]);
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
  mockByAlias.mockResolvedValue(null);
  mockById.mockResolvedValue(null);
});

function makeInput(overrides: Partial<Parameters<typeof contentIndexer.indexToolResult>[0]> = {}) {
  return {
    tenantId: 'tenant-uuid',
    agentId: 'agent-uuid',
    connector: 'slack',
    actionType: 'getMessages',
    idempotencyKey: 'idem-key',
    data: {
      id: 'msg-123',
      text: 'This is a test message with enough content to pass the minimum length check for indexing purposes.',
    },
    ...overrides,
  };
}

describe('contentIndexer.indexToolResult', () => {
  describe('Kill switch', () => {
    it('does nothing when CONNECTOR_CONTENT_INDEXING_ENABLED is not set', async () => {
      const original = process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
      delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
      await contentIndexer.indexToolResult(makeInput());
      expect(mockQuery).not.toHaveBeenCalled();
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = original;
    });

    it('does nothing when CONNECTOR_CONTENT_INDEXING_ENABLED=false', async () => {
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'false';
      await contentIndexer.indexToolResult(makeInput());
      expect(mockQuery).not.toHaveBeenCalled();
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    });
  });

  describe('Write/destructive action skip', () => {
    beforeEach(() => {
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
    });

    it('skips create actions', async () => {
      await contentIndexer.indexToolResult(makeInput({ actionType: 'create_record' }));
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('skips update actions', async () => {
      await contentIndexer.indexToolResult(makeInput({ actionType: 'update_message' }));
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('skips delete actions', async () => {
      await contentIndexer.indexToolResult(makeInput({ actionType: 'delete_item' }));
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('Text too short', () => {
    beforeEach(() => {
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
    });

    it('skips when extracted text is < 150 chars', async () => {
      await contentIndexer.indexToolResult(makeInput({
        data: { id: 'x', text: 'Too short.' },
      }));
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('isReadAction heuristic', () => {
    beforeEach(() => {
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
    });

    const sufficientText = 'A'.repeat(200);
    const readActions = ['getMessages', 'readFile', 'listChannels', 'fetchRecord', 'searchItems', 'findUser'];
    const writeActions = ['createRecord', 'updateMessage', 'deleteItem', 'postMessage', 'sendEmail'];

    it.each(readActions)('allows read action: %s', async (action) => {
      await contentIndexer.indexToolResult(makeInput({
        actionType: action,
        data: { id: 'x', text: sufficientText },
      }));
      expect(mockQuery).toHaveBeenCalled();
    });

    it.each(writeActions)('blocks write action: %s', async (action) => {
      await contentIndexer.indexToolResult(makeInput({
        actionType: action,
        data: { id: 'x', text: sufficientText },
      }));
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('Entity ID extraction', () => {
    beforeEach(() => {
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
    });

    const longText = 'A'.repeat(200);

    it('uses id field when present', async () => {
      await contentIndexer.indexToolResult(makeInput({
        data: { id: 'record-42', text: longText },
      }));
      // The upsert SQL has entity_id as $3; verify it contains the connector:id pattern
      const insertCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO connector_content'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][2]).toBe('slack:record-42');
    });

    it('falls back to SHA-256 hash when no id field', async () => {
      await contentIndexer.indexToolResult(makeInput({
        data: { text: longText },
      }));
      const insertCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO connector_content'),
      );
      expect(insertCall).toBeDefined();
      const entityId: string = insertCall[1][2];
      expect(entityId.startsWith('slack:')).toBe(true);
      // SHA hash portion is 32 hex chars
      expect(entityId.slice(6)).toMatch(/^[0-9a-f]{32}$/);
    });

    it('extracts nested sys.id (Contentful pattern) when no top-level id/_id', async () => {
      await contentIndexer.indexToolResult(makeInput({
        data: { sys: { id: 'contentful-entry-abc' }, text: longText },
      }));
      const insertCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO connector_content'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][2]).toBe('slack:contentful-entry-abc');
    });

    it('prefers top-level id over nested sys.id', async () => {
      await contentIndexer.indexToolResult(makeInput({
        data: { id: 'top-level-id', sys: { id: 'sys-id' }, text: longText },
      }));
      const insertCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO connector_content'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][2]).toBe('slack:top-level-id');
    });
  });

  describe('PII redaction', () => {
    beforeEach(() => {
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
    });

    it('redacts email before writing to DB', async () => {
      const padding = ' '.repeat(200); // ensure total length >= 150
      const textWithEmail = `Contact user@example.com for details. ${padding} end of message.`;
      await contentIndexer.indexToolResult(makeInput({
        data: { id: 'doc-1', text: textWithEmail },
      }));
      const insertCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO connector_content'),
      );
      expect(insertCall).toBeDefined();
      const storedContent: string = insertCall[1][6]; // content is $7 = index 6
      expect(storedContent).not.toContain('user@example.com');
      expect(storedContent).toContain('[REDACTED_EMAIL]');
    });
  });

  describe('Upsert on duplicate', () => {
    beforeEach(() => {
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
    });

    it('calls the same upsert SQL on second call (ON CONFLICT)', async () => {
      const input = makeInput({
        data: { id: 'entity-1', text: 'A'.repeat(200) },
      });
      await contentIndexer.indexToolResult(input);
      const firstCount = mockQuery.mock.calls.length;

      await contentIndexer.indexToolResult(input);
      // Both calls should each do one upsert (single chunk)
      expect(mockQuery.mock.calls.length).toBe(firstCount * 2);

      // Both calls use ON CONFLICT DO UPDATE
      const upsertCalls = mockQuery.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('ON CONFLICT'),
      );
      expect(upsertCalls.length).toBe(2);
    });
  });

  describe('Semaphore', () => {
    beforeEach(() => {
      process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
    });

    it('runs at most 3 calls simultaneously', async () => {
      let concurrentPeak = 0;
      let currentConcurrent = 0;

      (generateEmbeddingsBatch as jest.Mock).mockImplementation(async () => {
        currentConcurrent++;
        concurrentPeak = Math.max(concurrentPeak, currentConcurrent);
        // Simulate async work
        await new Promise(r => setTimeout(r, 5));
        currentConcurrent--;
        return [[0.1, 0.2, 0.3]];
      });

      const longText = 'A'.repeat(200);
      const inputs = Array.from({ length: 5 }, (_, i) =>
        makeInput({ data: { id: `e${i}`, text: longText } }),
      );

      await Promise.all(inputs.map(i => contentIndexer.indexToolResult(i)));
      expect(concurrentPeak).toBeLessThanOrEqual(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------
//
// The extraction that shipped descended one level of nesting and explicitly
// skipped arrays, so it saw text only in a bare top-level array or on a flat
// object. Every wrapper shape a REST list/search endpoint actually returns
// hides its text one array below a key that is not itself a text field, and all
// of them extracted to '' and were dropped before the database. Measured
// against the real function, 6 of these 8 were dropped.

describe('connector payload shapes', () => {
  const LONG =
    'The refund policy allows returns within thirty days of purchase provided '
    + 'the item is unused and in its original packaging. Customers must contact '
    + 'support for a return authorisation number before shipping anything back.';

  beforeEach(() => {
    process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    (generateEmbeddingsBatch as jest.Mock).mockImplementation((chunks: string[]) =>
      Promise.resolve(chunks.map(() => [0.1, 0.2, 0.3])));
  });
  afterEach(() => {
    delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
  });

  const indexed = async (data: unknown): Promise<boolean> => {
    mockQuery.mockClear();
    await contentIndexer.indexToolResult(makeInput({ actionType: 'search', data }));
    return mockQuery.mock.calls.length > 0;
  };

  it('indexes a bare array of records', async () => {
    expect(await indexed([{ id: '1', subject: 'Refunds', body: LONG }])).toBe(true);
  });

  it('indexes {messages:[...]}, the shape mail and chat connectors return', async () => {
    expect(await indexed({ messages: [{ id: '1', subject: 'Refunds', body: LONG }] })).toBe(true);
  });

  it('indexes {items:[...]}', async () => {
    expect(await indexed({ items: [{ id: '1', title: 'Refunds', description: LONG }] })).toBe(true);
  });

  it('indexes {results:[...]}', async () => {
    expect(await indexed({ results: [{ id: '1', text: LONG }] })).toBe(true);
  });

  it('indexes an ok-wrapped list, the Slack shape', async () => {
    expect(await indexed({ ok: true, messages: [{ text: LONG }] })).toBe(true);
  });

  it('indexes a doubly-nested envelope {data:{items:[...]}}', async () => {
    expect(await indexed({ data: { items: [{ text: LONG }] } })).toBe(true);
  });

  it('indexes a snippet, which mail search returns instead of a body', async () => {
    expect(await indexed({ messages: [{ id: '1', snippet: LONG }] })).toBe(true);
  });

  it('still indexes a flat single object', async () => {
    expect(await indexed({ id: '1', text: LONG })).toBe(true);
  });
});

describe('what must NOT reach the index', () => {
  beforeEach(() => {
    process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    (generateEmbeddingsBatch as jest.Mock).mockImplementation((chunks: string[]) =>
      Promise.resolve(chunks.map(() => [0.1, 0.2, 0.3])));
  });
  afterEach(() => {
    delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
  });

  it('ignores long identifier arrays — a string counts only under a text key', async () => {
    mockQuery.mockClear();
    await contentIndexer.indexToolResult(makeInput({
      actionType: 'list_messages',
      data: { messages: [{ id: 'x', labelIds: Array.from({ length: 40 }, (_, i) => `LABEL_NUMBER_${i}`) }] },
    }));
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('ignores a base64 body blob nested under a text key', async () => {
    mockQuery.mockClear();
    await contentIndexer.indexToolResult(makeInput({
      actionType: 'get_message',
      data: { messages: [{ payload: { body: { data: 'QUFB'.repeat(200) } } }] },
    }));
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still refuses a write action whatever its payload holds', async () => {
    mockQuery.mockClear();
    await contentIndexer.indexToolResult(makeInput({
      actionType: 'send_email',
      data: { messages: [{ body: 'x'.repeat(500) }] },
    }));
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('a drop is never silent', () => {
  beforeEach(() => {
    process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
  });

  it('logs the reason and the shape when nothing indexable came out', async () => {
    // The whole reason this component sat dead: it returned here and said
    // nothing, so an empty index was indistinguishable from an idle workspace.
    const { logger } = jest.requireMock('../../infrastructure/logging') as {
      logger: { info: jest.Mock };
    };
    logger.info.mockClear();

    await contentIndexer.indexToolResult(makeInput({
      actionType: 'list_threads',
      data: { threads: [{ id: '1' }, { id: '2' }] },
    }));

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: 'connector_content.not_indexed',
        reason: 'no_text_extracted',
        shape: '{threads}',
      }),
      expect.any(String),
    );
  });
});

describe('connector_type holds a TYPE, not whatever the caller passed', () => {
  // The column is named for a type but was written straight from
  // `input.connector` — an ALIAS on the in-process MCP path
  // (`connector: manifest.alias`) and a connector UUID over /api/v1/tool-calls.
  // `search` resolves the aliases a model names to `m.connectorType` and
  // filters on that, so a connector-scoped search matched ZERO rows however
  // much was indexed, and reported coverage 0 beside the empty result.
  const LONG = 'x '.repeat(200);

  beforeEach(() => {
    process.env.CONNECTOR_CONTENT_INDEXING_ENABLED = 'true';
    (generateEmbeddingsBatch as jest.Mock).mockImplementation((chunks: string[]) =>
      Promise.resolve(chunks.map(() => [0.1, 0.2, 0.3])));
  });
  afterEach(() => {
    delete process.env.CONNECTOR_CONTENT_INDEXING_ENABLED;
  });

  const storedType = () => (mockQuery.mock.calls[0]![1] as unknown[])[1];

  it('resolves an alias to its connector type', async () => {
    mockByAlias.mockResolvedValue({ connectorType: 'google_mail' });
    mockQuery.mockClear();
    await contentIndexer.indexToolResult(makeInput({
      connector: 'google-mail-0105297e', actionType: 'read_thread',
      data: { id: '1', messages: [{ body: LONG }] },
    }));
    expect(storedType()).toBe('google_mail');
  });

  it('resolves a connector UUID to its connector type', async () => {
    mockByAlias.mockResolvedValue(null);
    mockById.mockResolvedValue({ connectorType: 'google_mail' });
    mockQuery.mockClear();
    await contentIndexer.indexToolResult(makeInput({
      connector: '0105297e-eed8-4953-8be6-bdebd3cbf247', actionType: 'read_thread',
      data: { id: '2', messages: [{ body: LONG }] },
    }));
    expect(storedType()).toBe('google_mail');
  });

  it('still indexes under the raw value when the connector cannot be resolved', async () => {
    // Unfindable-by-filter beats not indexed at all.
    mockByAlias.mockResolvedValue(null);
    mockById.mockResolvedValue(null);
    mockQuery.mockClear();
    await contentIndexer.indexToolResult(makeInput({
      connector: 'mystery', actionType: 'read_thread',
      data: { id: '3', messages: [{ body: LONG }] },
    }));
    expect(storedType()).toBe('mystery');
  });
});
