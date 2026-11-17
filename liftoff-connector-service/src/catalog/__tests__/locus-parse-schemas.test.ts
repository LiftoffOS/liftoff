// What the generator does with a value list a source published as if it were
// a domain.
//
// The metadata here is real: Parse's marketplace entry for the Zillow API
// (api.parse.bot/marketplace/apis/082cc2d5-…, which the Locus catalog names as
// the endpoint's `schemaSource`), and the properties are the ones
// scripts/locus-catalog-sync.ts projects from what Locus publishes.

import { splitLocusSchemas, testInputFieldsFor, type ParseMarketplaceDoc } from '../locus-parse-schemas';

/** Parse's own metadata, as captured 2026-09-23. */
const PARSE_ZILLOW: ParseMarketplaceDoc = {
  apis: [
    {
      endpoint_name: 'search_homes_for_sale',
      input_params: {
        page: { },
        location: {
          closed: true,
          domain: {
            kind: 'enum',
            values: ['Los Angeles, CA', 'Seattle, WA', 'Chicago, IL', 'New York, NY', 'Austin, TX'],
            generator: { type: 'enum_pick' },
          },
        },
      },
    },
    {
      endpoint_name: 'get_property_details',
      input_params: {
        // A real derived value, not a test-input list.
        zpid: { domain: { kind: 'derived', generator: { type: 'derived' } } },
      },
    },
  ],
};

/** The properties the generator projects for `search_homes_for_sale`. */
function zillowProperties() {
  return {
    location: {
      type: 'string',
      description: "City and state, ZIP code, or neighborhood (e.g., 'Seattle, WA', '90210', 'Capitol Hill, Seattle, WA')",
      enum: ['Austin, TX', 'Chicago, IL', 'Los Angeles, CA', 'New York, NY', 'Seattle, WA'],
    },
    page: { type: 'integer', description: 'Page number for pagination (1-based) (default 1)' },
  };
}

describe('classifying a value list from metadata, never from prose', () => {
  it('names the field Parse marks closed with an enum_pick generator, and nothing else', () => {
    expect([...testInputFieldsFor(PARSE_ZILLOW, 'search_homes_for_sale')]).toEqual(['location']);
    expect([...testInputFieldsFor(PARSE_ZILLOW, 'get_property_details')]).toEqual([]);
    // An endpoint the document does not describe, and no document at all.
    expect([...testInputFieldsFor(PARSE_ZILLOW, 'search_agents')]).toEqual([]);
    expect([...testInputFieldsFor(null, 'search_homes_for_sale')]).toEqual([]);
  });

  it('does not classify a closed field whose generator is something else', () => {
    const doc: ParseMarketplaceDoc = {
      apis: [{ endpoint_name: 'x', input_params: { grade: { closed: true, domain: { kind: 'enum', values: ['a'], generator: { type: 'const' } } } } }],
    };
    expect([...testInputFieldsFor(doc, 'x')]).toEqual([]);
  });
});

describe('the two schemas', () => {
  it('relaxes the advisory enum for the model, keeps the type and every other constraint, and routes against the strict one', () => {
    const properties = zillowProperties();
    const split = splitLocusSchemas(properties, ['location'], testInputFieldsFor(PARSE_ZILLOW, 'search_homes_for_sale'));

    expect(split.relaxed).toEqual(['location']);
    // Model-facing: no enum, the values as examples, still a string, still
    // carrying its own description, still required.
    expect(split.inputSchema.properties.location).toEqual({
      type: 'string',
      description: "City and state, ZIP code, or neighborhood (e.g., 'Seattle, WA', '90210', 'Capitol Hill, Seattle, WA')",
      examples: ['Austin, TX', 'Chicago, IL', 'Los Angeles, CA', 'New York, NY', 'Seattle, WA'],
    });
    expect(split.inputSchema.required).toEqual(['location']);
    // Untouched fields are untouched.
    expect(split.inputSchema.properties.page).toEqual(properties.page);

    // Routing: exactly what Locus publishes and will enforce.
    expect(split.routingSchema?.properties.location).toEqual({
      type: 'string',
      description: "City and state, ZIP code, or neighborhood (e.g., 'Seattle, WA', '90210', 'Capitol Hill, Seattle, WA')",
      enum: ['Austin, TX', 'Chicago, IL', 'Los Angeles, CA', 'New York, NY', 'Seattle, WA'],
    });
    expect(split.routingSchema?.required).toEqual(['location']);
  });

  it('emits no routingSchema for a function whose enums are real', () => {
    const properties = { grade: { type: 'string', enum: ['regular', 'premium'] } };
    const split = splitLocusSchemas(properties, ['grade'], new Set());
    expect(split.relaxed).toEqual([]);
    expect(split.routingSchema).toBeNull();
    expect(split.inputSchema.properties.grade).toEqual({ type: 'string', enum: ['regular', 'premium'] });
  });

  it('a relaxed INTEGER stays an integer — which is why the classification cannot come from the description', () => {
    // `fuel_prices_get_news_articles.page` is published as
    // `{type: 'integer', enum: [1, 2]}`: two page numbers the scraper was
    // tested with, in a field whose description says "Page number for
    // pagination". No prose tells that apart from a real two-value enum, and
    // dropping the type with the enum would make every page number a string.
    const properties = { page: { type: 'integer', description: 'Page number for pagination. (default 1)', enum: [1, 2] } };
    const split = splitLocusSchemas(properties, [], new Set(['page']));
    expect(split.inputSchema.properties.page).toEqual({
      type: 'integer',
      description: 'Page number for pagination. (default 1)',
      examples: [1, 2],
    });
    expect(split.routingSchema?.properties.page).toEqual({ type: 'integer', description: 'Page number for pagination. (default 1)', enum: [1, 2] });
  });

  it('leaves a classified field alone when it carries no enum to relax', () => {
    const split = splitLocusSchemas({ location: { type: 'string' } }, [], new Set(['location']));
    expect(split.relaxed).toEqual([]);
    expect(split.routingSchema).toBeNull();
  });

  it('omits `required` from both schemas when the endpoint has none', () => {
    const split = splitLocusSchemas({ page: { type: 'integer', enum: [1, 2] } }, [], new Set(['page']));
    expect(split.inputSchema.required).toBeUndefined();
    expect(split.routingSchema?.required).toBeUndefined();
  });
});
