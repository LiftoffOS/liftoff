import {
  StreamableHttpTransport,
  SseTransport,
  createTransport,
  createTransportSync,
  detectTransportType,
  type MCPTransportConfig,
} from '../transports';
import { MCPClient } from '../../mcp/client';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock logging
jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('MCP Transports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('StreamableHttpTransport', () => {
    const config: MCPTransportConfig = {
      endpointUrl: 'https://example.com/mcp',
      authType: 'none',
    };

    it('connects without error (no-op)', async () => {
      const transport = new StreamableHttpTransport(config);
      await expect(transport.connect()).resolves.toBeUndefined();
    });

    it('returns correct transport type', () => {
      const transport = new StreamableHttpTransport(config);
      expect(transport.getType()).toBe('streamable-http');
    });

    it('sends JSON-RPC request via POST', async () => {
      const transport = new StreamableHttpTransport(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'Test', version: '1.0' } },
        }),
      });

      const result = await transport.request('initialize', { protocolVersion: '2024-11-05' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
      expect(result).toEqual({ serverInfo: { name: 'Test', version: '1.0' } });
    });

    it('includes API key header when authType is api_key', async () => {
      const apiKeyConfig: MCPTransportConfig = {
        endpointUrl: 'https://example.com/mcp',
        authType: 'api_key',
        apiKey: 'test-api-key',
      };
      const transport = new StreamableHttpTransport(apiKeyConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
      });

      await transport.request('test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'test-api-key',
          }),
        })
      );
    });

    it('includes bearer token when authType is bearer_token', async () => {
      const bearerConfig: MCPTransportConfig = {
        endpointUrl: 'https://example.com/mcp',
        authType: 'bearer_token',
        bearerToken: 'my-token',
      };
      const transport = new StreamableHttpTransport(bearerConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
      });

      await transport.request('test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
          }),
        })
      );
    });

    it('throws on MCP error response', async () => {
      const transport = new StreamableHttpTransport(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'Invalid request' },
        }),
      });

      await expect(transport.request('test')).rejects.toThrow('MCP error -32600: Invalid request');
    });

    it('throws on HTTP error', async () => {
      const transport = new StreamableHttpTransport(config);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(transport.request('test')).rejects.toThrow('MCP request failed: HTTP 500');
    });

    it('throws authentication error on 401/403', async () => {
      const transport = new StreamableHttpTransport(config);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      await expect(transport.request('test')).rejects.toThrow('Authentication failed');
    });
  });

  describe('detectTransportType', () => {
    const config: MCPTransportConfig = {
      endpointUrl: 'https://example.com/mcp',
      authType: 'none',
    };

    it('detects Streamable HTTP when POST succeeds', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'Test', version: '1.0' },
          },
        }),
      });

      const result = await detectTransportType(config);

      expect(result.transportType).toBe('streamable-http');
      expect(result.initializeResult).toBeDefined();
      expect(result.initializeResult?.serverInfo.name).toBe('Test');
    });

    it('falls back to initialize when server/discover is unavailable (MCP 2026-07-28)', async () => {
      // server/discover POST → method-not-found style failure
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      // initialize POST → succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'Legacy', version: '1.0' },
          },
        }),
      });

      const result = await detectTransportType(config);

      expect(result.transportType).toBe('streamable-http');
      expect(result.initializeResult?.serverInfo.name).toBe('Legacy');
    });

    it('detects SSE when POST fails and GET returns event-stream', async () => {
      // server/discover POST fails (MCP 2026-07-28 probe runs first)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      // initialize POST fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      // GET succeeds with SSE
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/event-stream']]),
      });

      const result = await detectTransportType(config);

      expect(result.transportType).toBe('sse');
      expect(result.initializeResult).toBeUndefined();
    });

    it('defaults to Streamable HTTP when all probes fail', async () => {
      // server/discover, then initialize, then SSE GET — all fail.
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await detectTransportType(config);

      expect(result.transportType).toBe('streamable-http');
    });

    it('includes auth headers in detection requests', async () => {
      const apiKeyConfig: MCPTransportConfig = {
        endpointUrl: 'https://example.com/mcp',
        authType: 'api_key',
        apiKey: 'test-key',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'Test', version: '1.0' } },
        }),
      });

      await detectTransportType(apiKeyConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'test-key',
          }),
        })
      );
    });
  });

  describe('createTransport', () => {
    it('creates Streamable HTTP transport when specified', async () => {
      const result = await createTransport({
        endpointUrl: 'https://example.com/mcp',
        authType: 'none',
        transportType: 'streamable-http',
      });

      expect(result.transport.getType()).toBe('streamable-http');
      expect(result.detectionResult).toBeUndefined();
    });

    it('auto-detects and returns detection result', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'AutoDetected', version: '1.0' },
          },
        }),
      });

      const result = await createTransport({
        endpointUrl: 'https://example.com/mcp',
        authType: 'none',
        transportType: 'auto',
      });

      expect(result.transport.getType()).toBe('streamable-http');
      expect(result.detectionResult?.transportType).toBe('streamable-http');
      expect(result.detectionResult?.initializeResult?.serverInfo.name).toBe('AutoDetected');
    });
  });

  describe('createTransportSync', () => {
    it('creates Streamable HTTP transport', () => {
      const transport = createTransportSync('streamable-http', {
        endpointUrl: 'https://example.com/mcp',
        authType: 'none',
      });

      expect(transport.getType()).toBe('streamable-http');
    });

    it('creates SSE transport', () => {
      const transport = createTransportSync('sse', {
        endpointUrl: 'https://example.com/sse',
        authType: 'none',
      });

      expect(transport.getType()).toBe('sse');
    });
  });

  describe('SseTransport', () => {
    const config: MCPTransportConfig = {
      endpointUrl: 'https://example.com/sse',
      authType: 'none',
    };

    it('returns correct transport type', () => {
      const transport = new SseTransport(config);
      expect(transport.getType()).toBe('sse');
    });

    it('throws when requesting before connect', async () => {
      const transport = new SseTransport(config);

      await expect(transport.request('test')).rejects.toThrow('Not connected');
    });

    // Note: Full SSE connection tests would require a more complex mock
    // that simulates the SSE stream with endpoint events
  });

  describe('MCPClient', () => {
    it('returns null for getDetectedTransportType before discover()', () => {
      const client = new MCPClient({
        endpointUrl: 'https://example.com/mcp',
        authType: 'none',
      });

      expect(client.getDetectedTransportType()).toBeNull();
    });

    it('returns detected transport type after discover()', async () => {
      const client = new MCPClient({
        endpointUrl: 'https://example.com/mcp',
        authType: 'none',
        transportType: 'streamable-http', // Skip auto-detection
      });

      // Mock initialize response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'Test', version: '1.0' },
          },
        }),
      });

      // Mock notifications/initialized response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ jsonrpc: '2.0', id: 2, result: {} }),
      });

      // Mock tools/list response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 3,
          result: { tools: [] },
        }),
      });

      // Mock resources/list response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 4,
          result: { resources: [] },
        }),
      });

      const result = await client.discover();

      expect(result.transportType).toBe('streamable-http');
      expect(client.getDetectedTransportType()).toBe('streamable-http');
    });
  });
});
