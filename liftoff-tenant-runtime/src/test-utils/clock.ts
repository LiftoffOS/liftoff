// Injectable clock for time-dependent logic.
// Production code uses systemClock (Date.now). Tests inject a mock.
// SQL queries use parameterized $now (from clock()) instead of NOW().

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
