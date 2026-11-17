import { createContext, useContext } from 'react'

export interface PlanGateValue {
  /** Opens the modal when `err` is a 402 from a launch attempt. Returns true if
   *  it handled the error, so callers can skip their own error toast. Anything
   *  else is not ours — returns false and the caller reports it. */
  openIfPaymentRequired: (err: unknown) => boolean
}

/**
 * Default for a mount with no provider above it: report the error as unhandled
 * so the caller falls through to its own toast.
 *
 * Deliberately NOT a throw. The hook's contract is "true if I showed the gate",
 * and a component with no gate above it genuinely has not shown one — falling
 * through is the correct answer, not a crash. Throwing would mean the choice of
 * where a component is mounted could white-screen it, which is a worse failure
 * than a missing modal. Nothing is weakened by this: the 402 is enforced at the
 * server, and this only decides which UI reports it.
 */
const PLAN_GATE_ABSENT: PlanGateValue = {
  openIfPaymentRequired: () => false,
}

export const PlanGateContext = createContext<PlanGateValue>(PLAN_GATE_ABSENT)

export function usePlanGate(): PlanGateValue {
  return useContext(PlanGateContext)
}
