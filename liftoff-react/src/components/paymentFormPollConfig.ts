// Mutable so tests can shrink the polling deadline without mocking timers.
// Defaults are tuned for production: 1s between polls; 30s deadline so a
// successful charge whose webhook lands at P99 (~10–30s) isn't misreported
// as a decline. Tests mutate these directly and restore in afterEach.
export const PAYMENT_FORM_POLL_CONFIG = {
  intervalMs: 1_000,
  timeoutMs: 30_000,
}
