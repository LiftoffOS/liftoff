// The status row's text and the type marker are spelled in two services and
// rendered by a third. These pins are the only thing that stops them drifting.

import {
  FORWARDED_CONTEXT_MESSAGE_TYPE,
  forwardedContextStatus,
  withForwardedContext,
} from '../workforce-plans/forwarded-context.js';

describe('forwarded context', () => {
  it('uses the marker platform-backend writes and liftoff-react renders', () => {
    expect(FORWARDED_CONTEXT_MESSAGE_TYPE).toBe('forwarded_context');
  });

  it('spells the status row exactly as platform-backend does', () => {
    expect(forwardedContextStatus('Insights Manager')).toBe(
      'Insights Manager shared background from the conversation so far',
    );
    expect(forwardedContextStatus('Liftoff')).toBe('Liftoff shared background from the conversation so far');
  });

  it('puts the brief in front of the person\'s words for the model, and nothing in front when there is none', () => {
    expect(withForwardedContext('yes', 'Background from Liftoff.')).toBe('Background from Liftoff.\n\nyes');
    expect(withForwardedContext('yes', null)).toBe('yes');
  });
});
