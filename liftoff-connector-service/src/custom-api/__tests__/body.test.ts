/**
 * Writing the body the way the provider asked for it.
 *
 * A model sends an object either way; what changes is how it goes on the wire.
 * Form encoding was 536 of the offences across ten public providers — all of
 * Stripe's 446 operations and most of Slack's, which now connects with all
 * 174 — and `new URLSearchParams(object)` does not cover it: it writes a list
 * as `"a,b"` and an object as `"[object Object]"`, both of which a provider
 * reads as data.
 */
import { encodeBody, encodeForm } from '../body.js';

describe('form encoding', () => {
  it('writes a scalar as itself', () => {
    expect(encodeForm({ amount: 500, currency: 'usd', capture: false }))
      .toBe('amount=500&currency=usd&capture=false');
  });

  it('repeats the key for a list, as the query does', () => {
    expect(encodeForm({ expand: ['customer', 'charges'] }))
      .toBe('expand=customer&expand=charges');
  });

  it('brackets a nested object, which is how a provider reads it back', () => {
    expect(encodeForm({ metadata: { order_id: '6735' } }))
      .toBe('metadata%5Border_id%5D=6735');
  });

  it('brackets all the way down, and repeats a list inside one', () => {
    expect(decodeURIComponent(encodeForm({ a: { b: { c: 1 } }, d: { e: ['x', 'y'] } })))
      .toBe('a[b][c]=1&d[e]=x&d[e]=y');
  });

  it('drops an absent value instead of writing the word for it', () => {
    // A provider reading "null" as a value is a bug that looks like data.
    expect(encodeForm({ a: 1, b: null, c: undefined, d: { e: null, f: 2 } }))
      .toBe('a=1&d%5Bf%5D=2');
  });

  it('escapes what has to be escaped', () => {
    expect(encodeForm({ 'a b': 'c&d=e' })).toBe('a+b=c%26d%3De');
  });
});

describe('choosing the encoding', () => {
  it('writes JSON when the operation declares nothing', () => {
    expect(encodeBody({ a: 1 }, undefined))
      .toEqual({ payload: '{"a":1}', contentType: 'application/json' });
  });

  it('writes a form when the specification said so, and says that it did', () => {
    expect(encodeBody({ a: 1 }, 'application/x-www-form-urlencoded'))
      .toEqual({ payload: 'a=1', contentType: 'application/x-www-form-urlencoded' });
  });

  it('keeps an unusual declared type as JSON rather than inventing a writer for it', () => {
    // The subset check only ever lets JSON or a form through, so this is the
    // belt to that brace: an unexpected type is written as JSON and SAID to be
    // what it is, never written one way and labelled another.
    expect(encodeBody({ a: 1 }, 'application/vnd.acme+json'))
      .toEqual({ payload: '{"a":1}', contentType: 'application/vnd.acme+json' });
  });
});
