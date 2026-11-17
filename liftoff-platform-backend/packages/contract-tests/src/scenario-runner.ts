// Stateful scenario runner for multi-RPC contract flows. Needed for
// HRBP provisioning, CAIO draft→commit and billing webhook→invoice.
//
// Each step:
//   1. Invokes an adapter function the caller provides (HTTP call or
//      in-process handler — runner is transport-agnostic).
//   2. Validates the response against a contract validator.
//   3. Runs a post-assertion over accumulated state.
//
// A failed step short-circuits the scenario and returns the stepIndex
// at which failure occurred plus a reason.

export interface ScenarioStep<TInput, TOutput, TState> {
  name: string;
  /** Called after previous step's `update` completes. Produces the input for this step. */
  input: (state: TState) => TInput;
  /** Invokes the RPC / handler. Runner is transport-agnostic. */
  invoke: (input: TInput) => Promise<TOutput>;
  /** Contract validator — typically one of the exports from new-service-validators. */
  validateResponse: (payload: unknown) => { valid: boolean; errors?: unknown };
  /** Mutates scenario state with this step's output. */
  update: (state: TState, output: TOutput) => TState;
  /** Optional invariant check. Runs after `update`. */
  assert?: (state: TState) => { ok: boolean; reason?: string };
}

export interface ScenarioResult<TState> {
  success: boolean;
  finalState: TState;
  failedStep?: {
    index: number;
    name: string;
    reason: string;
    errors?: unknown;
  };
  stepsCompleted: number;
}

export async function runScenario<TState>(
  initialState: TState,
  steps: Array<ScenarioStep<unknown, unknown, TState>>,
): Promise<ScenarioResult<TState>> {
  let state = initialState;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const input = step.input(state);

    let output: unknown;
    try {
      output = await step.invoke(input);
    } catch (err) {
      return {
        success: false,
        finalState: state,
        failedStep: {
          index: i,
          name: step.name,
          reason: `invoke threw: ${err instanceof Error ? err.message : String(err)}`,
        },
        stepsCompleted: i,
      };
    }

    const validation = step.validateResponse(output);
    if (!validation.valid) {
      return {
        success: false,
        finalState: state,
        failedStep: {
          index: i,
          name: step.name,
          reason: 'response failed contract validation',
          errors: validation.errors,
        },
        stepsCompleted: i,
      };
    }

    state = step.update(state, output);

    if (step.assert) {
      const assertion = step.assert(state);
      if (!assertion.ok) {
        return {
          success: false,
          finalState: state,
          failedStep: {
            index: i,
            name: step.name,
            reason: assertion.reason ?? 'assertion failed',
          },
          stepsCompleted: i + 1,
        };
      }
    }
  }

  return {
    success: true,
    finalState: state,
    stepsCompleted: steps.length,
  };
}
