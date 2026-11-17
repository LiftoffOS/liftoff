// The two schemas a resold Parse function carries, and how the generator
// tells them apart.
//
// THE DEFECT. Parse's metadata describes a field's TEST INPUTS beside its
// description: Zillow's `location` is documented as "City and state, ZIP code,
// or neighborhood (e.g., 'Seattle, WA', '90210', 'Capitol Hill, Seattle, WA')"
// and carries `"closed": true` with five cities and
// `"generator": {"type": "enum_pick"}` — the five inputs Parse tests the
// scraper with. Locus turns that list into a hard JSON-Schema `enum` and
// refuses anything outside it before the call reaches Parse, which accepts
// free text: every search for Palo Alto, for a ZIP, for a neighbourhood came
// back `HTTP 400 Invalid request`, in 126 to 362 ms, charged nothing, and the
// model was told only that its request was invalid.
//
// THE SHAPE OF THE FIX. One schema cannot be both "what a model may ask for"
// and "what the vendor will accept", so there are two:
//
//   inputSchema    the MODEL-FACING schema. The advisory enum is gone — the
//                  property keeps its type and every other constraint, and
//                  the listed values move to `examples`, which is what they
//                  always were.
//   routingSchema  the STRICT schema Locus enforces, carried for the
//                  backend's pre-dispatch check and never shown to a model.
//                  Present only when it differs from inputSchema.
//
// CLASSIFIED FROM METADATA, NEVER FROM PROSE. A description heuristic would
// have to decide that `page` with `enum: [1, 2]` is advisory while some other
// integer enum is real, from the same English; Parse says which it is in
// structured metadata, and that is the only thing read here.

/** The subset of Parse's marketplace metadata this reads. */
export interface ParseMarketplaceDoc {
  apis?: Array<{
    endpoint_name?: string;
    input_params?: Record<string, {
      closed?: boolean;
      domain?: { kind?: string; values?: unknown[]; generator?: { type?: string } };
    }>;
  }>;
}

export interface GeneratedSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * The parameters of one Parse endpoint whose declared values are TEST INPUTS
 * rather than the field's real domain: `closed: true` with an `enum_pick`
 * generator. Both, because `closed` alone is Parse saying the value set is
 * fixed, and `enum_pick` is Parse saying the set is what its generator picks
 * a test value from.
 */
export function testInputFieldsFor(doc: ParseMarketplaceDoc | null, endpointName: string): Set<string> {
  const out = new Set<string>();
  const api = (doc?.apis ?? []).find((a) => a?.endpoint_name === endpointName);
  for (const [name, param] of Object.entries(api?.input_params ?? {})) {
    if (param?.closed === true && param?.domain?.generator?.type === 'enum_pick') out.add(name);
  }
  return out;
}

/** The model-facing property: the advisory enum removed, its values kept as
 *  examples, and every other keyword — the type above all — untouched. A
 *  relaxed `page` is still an integer. */
function relaxAdvisoryEnum(property: Record<string, unknown>): Record<string, unknown> {
  const { enum: values, ...rest } = property;
  return Array.isArray(values) && values.length > 0 ? { ...rest, examples: values } : { ...rest };
}

/**
 * One function's two schemas. `routingSchema` is null when nothing was
 * relaxed — there is then nothing for the strict schema to say that the
 * model-facing one does not.
 *
 * `relaxed` is the list of fields that were reclassified, so the count of
 * affected fields comes from the generator rather than from an estimate.
 */
export function splitLocusSchemas(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
  testInputFields: ReadonlySet<string>,
): { inputSchema: GeneratedSchema; routingSchema: GeneratedSchema | null; relaxed: string[] } {
  const relaxed: string[] = [];
  const modelFacing: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (testInputFields.has(name) && Array.isArray(property.enum) && property.enum.length > 0) {
      relaxed.push(name);
      modelFacing[name] = relaxAdvisoryEnum(property);
      continue;
    }
    modelFacing[name] = property;
  }
  const inputSchema: GeneratedSchema = { type: 'object', properties: modelFacing, ...(required.length ? { required } : {}) };
  if (relaxed.length === 0) return { inputSchema, routingSchema: null, relaxed };
  // The strict schema is what Locus publishes, unchanged: it is the thing
  // Locus will enforce, and guessing at it would put us back where we were.
  return {
    inputSchema,
    routingSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    relaxed,
  };
}
