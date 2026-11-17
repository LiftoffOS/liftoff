// What a failed poll means, and who it belongs to.
//
// The distinction these tests pin is not cosmetic. `connectors.status = 'error'`
// renders in the product as "Reconnect", so classifying a failure as
// `credential` is an instruction to a person to go redo an OAuth flow. Get it
// wrong in one direction and a broken connector shows as Connected for hours.
// Get it wrong in the other and
// someone reconnects repeatedly against a defect no reconnect can fix, and
// stops believing the signal.

import {
  classifyPollFailure,
  shouldFlipToError,
  worseFailure,
  AUTH_FAILURE_FLIP_THRESHOLD,
} from './poll-failure-state.js';
import { MissingBearerTokenError } from '../clients/composio-transport.js';
import { OAuthRefreshError } from '../credentials/service.js';

describe('classifyPollFailure', () => {
  it('reads a vendor 401 as a credential problem', () => {
    // The literal error a failing Gmail poller throws.
    expect(classifyPollFailure(new Error('Gmail list failed: 401'))).toBe('credential');
  });

  it('reads a 403 as a credential problem', () => {
    expect(classifyPollFailure(new Error('Google Calendar list failed: 403'))).toBe('credential');
  });

  it('reads the Apollo wording as a credential problem too', () => {
    // Each client throws its own prose; the classifier must not be tuned to one.
    expect(classifyPollFailure(new Error('Failed to search Apollo contacts (Status 401): Unknown error')))
      .toBe('credential');
  });

  it('trusts the typed refresh failure without reading prose', () => {
    const err = new OAuthRefreshError('reconnect_required', 'token dead', {
      connectorId: 'c1', tenantId: 't1', vendor: 'google_mail',
    });
    expect(classifyPollFailure(err)).toBe('credential');
  });

  it('reads a missing bearer as a CODE defect, never a credential one', () => {
    // The case that matters most. This error means the client never had a token
    // to send — reconnecting cannot fix it, so it must not be dressed up as a
    // credential problem and shown to a customer as "Reconnect".
    const err = new MissingBearerTokenError('google_mail', true);
    expect(classifyPollFailure(err)).toBe('code');
  });

  it('leaves everything else transient', () => {
    expect(classifyPollFailure(new Error('502 Bad Gateway'))).toBe('transient');
    expect(classifyPollFailure(new Error('socket hang up'))).toBe('transient');
    expect(classifyPollFailure(new Error('Too Many Requests'))).toBe('transient');
    expect(classifyPollFailure(undefined)).toBe('transient');
  });

  it('does not mistake an id containing 401 for a status code', () => {
    // Word-boundary matching, so a message id or a record count cannot flip a
    // healthy connector into "Reconnect".
    expect(classifyPollFailure(new Error('failed for record 1a00b81401598296bb4'))).toBe('transient');
  });
});

describe('shouldFlipToError', () => {
  it('never flips on a code defect, however long it runs', () => {
    expect(shouldFlipToError('code', 1)).toBe(false);
    expect(shouldFlipToError('code', 500)).toBe(false);
  });

  it('never flips on transient failures', () => {
    expect(shouldFlipToError('transient', 500)).toBe(false);
  });

  it('tolerates a blip below the threshold', () => {
    // A redeploy or a brief vendor wobble must not park a working connector,
    // because `error` stops polling entirely (getDueConnectors filters on
    // status = 'active') and only a human reconnect restarts it.
    expect(shouldFlipToError('credential', AUTH_FAILURE_FLIP_THRESHOLD - 1)).toBe(false);
  });

  it('flips once rejection is sustained', () => {
    expect(shouldFlipToError('credential', AUTH_FAILURE_FLIP_THRESHOLD)).toBe(true);
    expect(shouldFlipToError('credential', AUTH_FAILURE_FLIP_THRESHOLD + 50)).toBe(true);
  });

  it('reaches the threshold in minutes, not hours', () => {
    // Gmail failed ~85 consecutive cycles before a human noticed. At the 60s
    // base cycle this bound is what turns that into a five-minute signal.
    expect(AUTH_FAILURE_FLIP_THRESHOLD).toBeLessThanOrEqual(10);
    expect(AUTH_FAILURE_FLIP_THRESHOLD).toBeGreaterThan(1);
  });
});

describe('worseFailure — which failure speaks for the connector', () => {
  it('takes the first failure when there is nothing to compare', () => {
    expect(worseFailure(null, 'transient')).toBe('transient');
    expect(worseFailure(null, 'credential')).toBe('credential');
  });

  it('promotes transient to credential', () => {
    expect(worseFailure('transient', 'credential')).toBe('credential');
  });

  it('never demotes a credential failure back to transient', () => {
    expect(worseFailure('credential', 'transient')).toBe('credential');
  });

  it('lets a code defect outrank everything, and never be outranked', () => {
    // The property that keeps "this is ours" from being reported to a customer
    // as "your credential expired".
    expect(worseFailure('credential', 'code')).toBe('code');
    expect(worseFailure('transient', 'code')).toBe('code');
    expect(worseFailure('code', 'credential')).toBe('code');
    expect(worseFailure('code', 'transient')).toBe('code');
  });
});
