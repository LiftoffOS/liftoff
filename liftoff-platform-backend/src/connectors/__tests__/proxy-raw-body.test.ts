// A signed webhook's bytes must reach connector-service unchanged.
//
// The connector proxy re-serializes: `body = JSON.stringify(req.body)`. That is
// right for ordinary JSON calls and fatal for an HMAC-signed one, because the
// digest is computed over the exact bytes the sender signed and a round trip
// through parse-and-stringify does not reproduce them — key order, whitespace,
// and number formatting all move.
//
// The guard that was NOT enough: the pre-existing `typeof req.body === 'string'`
// branch is unreachable for any non-empty body, because `Object.keys('{"a":1}')`
// returns the string's indices and so the branch above it matches first. A
// Buffer has the same problem. So raw bodies had to be handled explicitly, and
// first.
//
// This matters for GitHub specifically: when a non-owner requests the App,
// `installation.created` is the only signal an owner ever approved it. A
// signature broken in transit means a pending install that never resolves and
// no error anywhere.

import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}), { virtual: true });

describe('connector proxy raw-body passthrough', () => {
  // A body whose re-serialization would differ from its original bytes: extra
  // whitespace and a key order JSON.stringify would not reproduce.
  const RAW = '{ "action":"created",  "installation": { "id": 999 } }';
  const SECRET = 'whsec';
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(RAW)).digest('hex')}`;

  function upstreamEcho() {
    // Stands in for connector-service: recomputes the digest over what it
    // actually received, which is the only question worth asking.
    const app = express();
    app.use('/api/connectors/github/webhook', express.raw({ type: '*/*' }), (req, res) => {
      const received = req.body as Buffer;
      const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(received).digest('hex')}`;
      res.json({
        signatureMatches: expected === req.headers['x-hub-signature-256'],
        received: received.toString('utf8'),
      });
    });
    return app;
  }

  it('re-serialization would break the signature (the reason this exists)', () => {
    // Demonstrates the failure the passthrough prevents, so the test does not
    // merely assert that today's code does what today's code does.
    const reSerialized = JSON.stringify(JSON.parse(RAW));
    const digestOfReSerialized =
      `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(reSerialized)).digest('hex')}`;
    expect(reSerialized).not.toBe(RAW);
    expect(digestOfReSerialized).not.toBe(signature);
  });

  it('the raw bytes survive a round trip through express.raw', async () => {
    const res = await request(upstreamEcho())
      .post('/api/connectors/github/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(RAW);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(RAW);
    expect(res.body.signatureMatches).toBe(true);
  });

  it('a Buffer body converts to a byte-identical Uint8Array', () => {
    // What the proxy now does. Copied into a fresh view rather than passed
    // through, because a Buffer's ArrayBuffer can be a slice of a larger pooled
    // allocation — handing the raw buffer to fetch can send bytes that were
    // never part of this request.
    const buf = Buffer.from(RAW);
    const asBody = new Uint8Array(buf);
    expect(Buffer.from(asBody).toString('utf8')).toBe(RAW);
    expect(asBody.byteLength).toBe(Buffer.byteLength(RAW));
  });
});
