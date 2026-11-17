// Tests for the pure weighting step of the server-side hours-saved estimate.
// The SQL wrapper (getHoursSaved30d) is exercised in integration; weightHours
// carries the semantics moved out of the React useTeamStats hook.
import { weightHours } from '../hours-saved';

describe('weightHours', () => {
  it('returns 0 for no rows', () => {
    expect(weightHours([])).toBe(0);
  });

  it('applies per-action weights', () => {
    // analyze_data 2.0h ×2 + send_notification 0.1h ×10 = 5h
    expect(weightHours([
      { action: 'analyze_data', cnt: 2 },
      { action: 'send_notification', cnt: 10 },
    ])).toBe(5);
  });

  it('falls back to 0.5h for unknown actions', () => {
    expect(weightHours([{ action: 'some_new_tool_call', cnt: 4 }])).toBe(2);
  });

  it('rounds the total', () => {
    // route_inquiry 0.25 ×3 = 0.75 → 1
    expect(weightHours([{ action: 'route_inquiry', cnt: 3 }])).toBe(1);
  });
});
