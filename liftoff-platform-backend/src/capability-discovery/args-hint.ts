// What a capability takes, as the model reads it in a search result.
//
// A name alone is not enough to make a call: `fields` could be a list or a
// comma-separated string, and a source that requires it says nothing about it
// until the call is rejected. The hint therefore carries each argument's type
// and whether it is required, the required ones first, so a call can be made
// right the first time from the search result alone.

export interface ArgSummary {
  name: string;
  /** The JSON-schema type, as a phrase: 'string', 'array of string', … */
  type: string | null;
  required: boolean;
}

interface Property {
  type?: string | string[];
  items?: { type?: string | string[] };
}

function typePhrase(property: Property | undefined): string | null {
  if (!property) return null;
  const own = Array.isArray(property.type) ? property.type.filter((t) => t !== 'null').join(' or ') : property.type;
  if (!own) return null;
  if (own === 'array') {
    const items = property.items;
    const itemType = items && (Array.isArray(items.type) ? items.type.join(' or ') : items.type);
    return itemType ? `array of ${itemType}` : 'array';
  }
  return own;
}

/** The top-level arguments of an input schema, required first, at most `max`. */
export function summarizeArgs(schema: unknown, max = 8): ArgSummary[] {
  if (!schema || typeof schema !== 'object') return [];
  const { properties, required } = schema as { properties?: Record<string, Property>; required?: unknown };
  if (!properties) return [];
  const requiredNames = new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : []);
  const all = Object.entries(properties).map(([name, property]) => ({
    name,
    type: typePhrase(property),
    required: requiredNames.has(name),
  }));
  return [...all.filter((a) => a.required), ...all.filter((a) => !a.required)].slice(0, max);
}

/** The hint as it reads in a search result: '; args: fields (string, required), page (integer)'. */
export function renderArgsHint(args: ArgSummary[]): string {
  if (args.length === 0) return '';
  const parts = args.map((a) => {
    const qualifiers = [a.type, a.required ? 'required' : null].filter((q): q is string => q !== null);
    return qualifiers.length > 0 ? `${a.name} (${qualifiers.join(', ')})` : a.name;
  });
  return `; args: ${parts.join(', ')}`;
}
