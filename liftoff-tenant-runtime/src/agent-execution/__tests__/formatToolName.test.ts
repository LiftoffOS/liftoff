import { formatToolName } from '../service';

describe('formatToolName', () => {
  it('returns `connector__actionType` when connector is non-empty', () => {
    expect(formatToolName({ connector: 'gmail', actionType: 'send_email' })).toBe('gmail__send_email');
  });

  it('returns bare actionType when connector is empty string', () => {
    expect(formatToolName({ connector: '', actionType: 'slack_send_message' })).toBe('slack_send_message');
  });

  it('returns bare actionType for standard tools (no connector prefix)', () => {
    expect(formatToolName({ connector: '', actionType: 'memory_save' })).toBe('memory_save');
  });
});
