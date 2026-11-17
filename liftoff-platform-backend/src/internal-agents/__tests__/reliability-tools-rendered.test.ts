// The reliability tools are printed, with their signature.
//
// Every other family the model authors against is rendered somewhere — the
// connector tools under their integration, the web tools in PLATFORM RESEARCH
// TOOLS, the sandbox tools in WORKSPACE TOOLS. These two were put in the
// catalog, which is what makes a step naming one pass name-validation, and
// never printed. So the model authored `have_i_acted_on` against a single
// hand-written sentence and got its arguments wrong every time.

import { readFileSync } from 'fs';
import { join } from 'path';
import { PLATFORM_RELIABILITY_TOOLS } from '../distill-service';

const SOURCE = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

describe('the reliability tools reach the prompt', () => {
  it('has a section of its own, like every other tool family', () => {
    expect(SOURCE).toContain('PLATFORM RELIABILITY TOOLS');
    // Interpolated into the user message, not merely declared.
    expect(SOURCE).toMatch(/\$\{reliabilityToolsText\}/);
  });

  it('renders through the shared signature helper, not a second format', () => {
    // A second copy is a second thing to keep in step, and the drift would be
    // invisible: both would look like a tool list.
    expect(SOURCE).toMatch(/PLATFORM_RELIABILITY_TOOLS\.map\(renderToolLine\)/);
  });

  it('carries a schema for every tool that takes arguments', () => {
    // renderToolLine falls back to `name: description` with no schema, which is
    // exactly the state that caused this. Asserted on the constant so a new
    // tool added without one fails here rather than in a distillation.
    //
    // `data_landscape` takes none — that is a real answer, not an omission, and
    // it is the one entry allowed to render bare.
    for (const t of PLATFORM_RELIABILITY_TOOLS) {
      const schema = t.input_schema as { properties?: Record<string, unknown> } | undefined;
      expect(schema).toBeDefined();
      if (t.name === 'data_landscape') continue;
      expect(Object.keys(schema?.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('mirrors the runtime, which is what actually validates the call', () => {
    // Copied schemas drift, and the drift is invisible: the prompt would keep
    // describing arguments the tool stopped taking. Spot-checked on the two
    // whose required set this session turned on.
    const byName = new Map(PLATFORM_RELIABILITY_TOOLS.map((t) => [t.name, t]));
    const req = (n: string) =>
      ((byName.get(n)?.input_schema as { required?: string[] } | undefined)?.required ?? []).sort();
    expect(req('have_i_acted_on')).toEqual(['connector', 'target']);
    expect(req('schedule_followup')).toEqual(['context_ref', 'objective']);
  });

  it('states what the * and :object marks mean', () => {
    // The signature is only readable if the notation is explained once.
    expect(SOURCE).toMatch(/A parameter marked \* is REQUIRED/);
    expect(SOURCE).toMatch(/marked :object takes an object/);
  });

  it('is not smuggled into the integrations renderer', () => {
    // Where it was first put — after an early return that fires when the agent
    // has no integrations, which is the population most dependent on tools that
    // need none.
    const fn = SOURCE.slice(
      SOURCE.indexOf('function formatIntegrationsWithTools('),
      SOURCE.indexOf('/** The workspace toolset, named.'),
    );
    // `_unaliased` remains as the BUCKET key — that is just how tools without a
    // connector prefix are grouped. What must not be here is the rendering: the
    // function returns 'None specified' before it when the agent has no
    // integrations, which is the population most dependent on tools needing none.
    expect(fn).not.toContain('platformSection');
    expect(fn).toContain("return 'None specified'");
  });
});
