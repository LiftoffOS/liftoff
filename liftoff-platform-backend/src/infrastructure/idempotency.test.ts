// src/infrastructure/idempotency.test.ts
import { withIdempotency } from './idempotency'

// Create stable mock client and pool
const mockClientQuery = jest.fn()
const mockClientRelease = jest.fn()
const mockClient = {
  // RLS: swallow the own-tx set_config so ordered mockResolvedValueOnce
  // sequences (BEGIN → advisory lock → SELECT → INSERT → COMMIT) are unaffected.
  query: (...args: unknown[]) =>
    typeof args[0] === 'string' && (args[0] as string).includes('set_config')
      ? Promise.resolve({})
      : mockClientQuery(...args),
  release: mockClientRelease,
}

const mockPoolConnect = jest.fn()
const mockPoolInstance = {
  connect: mockPoolConnect,
}

// Mock the database module
jest.mock('./database', () => ({
  getPool: jest.fn(() => mockPoolInstance),
}))

describe('withIdempotency', () => {
  beforeEach(() => {
    // Reset mocks
    mockClientQuery.mockReset()
    mockClientRelease.mockReset()
    mockPoolConnect.mockReset()
    mockPoolConnect.mockResolvedValue(mockClient)
  })

  it('should return cached response for same idempotency key', async () => {
    const operation = jest.fn().mockResolvedValue({ status: 201, body: { id: '123' } })

    // First call - no existing key
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing key (not found)
      .mockResolvedValueOnce({}) // INSERT new key
      .mockResolvedValueOnce({}) // COMMIT

    await withIdempotency('tenant-1', 'key-1', 'POST /teams', 'hash', operation)

    // Second call - key exists
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({
        rows: [{ request_hash: 'hash', response_status: 201, response_body: { id: '123' } }]
      }) // SELECT existing key (found)
      .mockResolvedValueOnce({}) // COMMIT

    const result2 = await withIdempotency('tenant-1', 'key-1', 'POST /teams', 'hash', operation)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(result2.cached).toBe(true)
    expect(result2.response).toEqual({ id: '123' })
  })

  it('should prevent race condition with concurrent requests', async () => {
    // Note: This test verifies sequential behavior - first request executes operation,
    // second request finds cached result. With mocks, we simulate the expected DB state.
    // True race condition testing requires integration tests with real advisory locks.

    const operation = jest.fn().mockResolvedValue({ status: 201, body: { id: 'team-1' } })

    // First request - no existing key
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT (not found)
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({}) // COMMIT

    const result1 = await withIdempotency('tenant-1', 'concurrent-key', 'POST /teams', 'hash', operation)

    // Second request - finds cached result
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({
        rows: [{ request_hash: 'hash', response_status: 201, response_body: { id: 'team-1' } }]
      }) // SELECT (found - cached)
      .mockResolvedValueOnce({}) // COMMIT

    const result2 = await withIdempotency('tenant-1', 'concurrent-key', 'POST /teams', 'hash', operation)

    // Only one operation should have executed
    expect(operation).toHaveBeenCalledTimes(1)

    // Both should return same result
    expect((result1.response as { id: string }).id).toBe((result2.response as { id: string }).id)
  })

  it('should reject reused key with different request hash', async () => {
    // First call - store with hash-1
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT (not found)
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({}) // COMMIT

    await withIdempotency('tenant-1', 'key-1', 'POST /teams', 'hash-1', async () => ({
      status: 201, body: {}
    }))

    // Second call - same key but different hash
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({
        rows: [{ request_hash: 'hash-1', response_status: 201, response_body: {} }]
      }) // SELECT (found with different hash)
      .mockResolvedValueOnce({}) // ROLLBACK

    await expect(
      withIdempotency('tenant-1', 'key-1', 'POST /teams', 'hash-2', async () => ({
        status: 201, body: {}
      }))
    ).rejects.toThrow('Idempotency key reused with different request body')
  })

  it('should allow same key for different endpoints', async () => {
    const operation = jest.fn().mockResolvedValue({ status: 201, body: { id: '1' } })

    // First endpoint
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({}) // COMMIT

    await withIdempotency('tenant-1', 'key-1', 'POST /teams', 'hash', operation)

    // Second endpoint - same key, different endpoint
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT (not found for this endpoint)
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({}) // COMMIT

    await withIdempotency('tenant-1', 'key-1', 'POST /agents', 'hash', operation)

    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('should allow same key for different tenants', async () => {
    const operation = jest.fn().mockResolvedValue({ status: 201, body: { id: '1' } })

    // First tenant
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({}) // COMMIT

    await withIdempotency('tenant-1', 'key-1', 'POST /teams', 'hash', operation)

    // Second tenant - same key
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({}) // COMMIT

    await withIdempotency('tenant-2', 'key-1', 'POST /teams', 'hash', operation)

    expect(operation).toHaveBeenCalledTimes(2)
  })
})
