// Verifies that the synthetic non-catalog fixture corpus actively triggers
// each invariant when loaded with the companion `_catalog.yaml` — guards
// against the I1 "dormant until a connector PR ships entity schemas" failure
// mode by exercising the catalog-side trigger via fixture-only state.
//
// Does NOT call the LLM. The harness in verify-distill-invariants.ts runs the
// real LLM and checks the output side; this test only verifies that the input
// side classification matches expectations for each fixture.

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import {
  INVARIANTS,
  type InputDoc,
} from '../verify-distill-invariants-lib';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'synthetic-non-catalog-inputs');

function loadFixture(filename: string): InputDoc {
  const raw = yaml.load(fs.readFileSync(path.join(FIXTURE_DIR, filename), 'utf-8')) as Record<string, unknown>;
  return {
    filePath: filename,
    role: (raw.role as string) ?? '',
    responsibilities: (raw.responsibilities as string) ?? '',
    additionalContext: (raw.additionalContext as string) ?? '',
    connectorRefs: [
      ...((raw.requiredConnectors as InputDoc['connectorRefs']) ?? []),
      ...((raw.optionalConnectors as InputDoc['connectorRefs']) ?? []),
    ],
  };
}

function loadSyntheticCatalog(): Record<string, Record<string, unknown>> {
  const raw = yaml.load(fs.readFileSync(path.join(FIXTURE_DIR, '_catalog.yaml'), 'utf-8'));
  return raw as Record<string, Record<string, unknown>>;
}

const [I1, I2, I3, I4] = INVARIANTS;

describe('synthetic fixture corpus + synthetic catalog actively triggers each invariant', () => {
  const syntheticCatalog = loadSyntheticCatalog();
  const emptyCatalog = {};

  it('i1-entity-store-deadline.yaml triggers I1 against the synthetic catalog', () => {
    const doc = loadFixture('i1-entity-store-deadline.yaml');
    const result = I1.triggersOnInput(doc, syntheticCatalog);
    expect(result.triggers).toBe(true);
    expect(result.reason).toMatch(/responsibilities \+ catalog both present/);
  });

  it('i1-entity-store-deadline.yaml does NOT trigger I1 against an empty catalog (proves the catalog-side gate works)', () => {
    const doc = loadFixture('i1-entity-store-deadline.yaml');
    const result = I1.triggersOnInput(doc, emptyCatalog);
    expect(result.triggers).toBe(false);
    expect(result.reason).toMatch(/catalog declares no anchoring field/);
  });

  it('i2-event-keyed-deadline.yaml triggers I2 (event-keyed language)', () => {
    const doc = loadFixture('i2-event-keyed-deadline.yaml');
    expect(I2.triggersOnInput(doc, emptyCatalog).triggers).toBe(true);
  });

  it('i3-multi-deadline-per-entity.yaml triggers I3 (Touch 1/2/3 sequence)', () => {
    const doc = loadFixture('i3-multi-deadline-per-entity.yaml');
    expect(I3.triggersOnInput(doc, emptyCatalog).triggers).toBe(true);
  });

  it('i4-business-days.yaml triggers I4 ("business days" language)', () => {
    const doc = loadFixture('i4-business-days.yaml');
    expect(I4.triggersOnInput(doc, emptyCatalog).triggers).toBe(true);
  });

  // i5 is output-driven — its triggersOnInput always returns false. The output-side
  // check is exercised by the harness against the real LLM; the unit suite covers
  // the satisfiedByOutput branches directly.
});

describe('_catalog.yaml shape', () => {
  const syntheticCatalog = loadSyntheticCatalog();

  it('declares the synthetic_crm connectorType used by the i1 fixture', () => {
    expect(syntheticCatalog).toHaveProperty('synthetic_crm');
  });

  it('synthetic_crm.account declares renewal_date so the catalog-side I1 trigger fires', () => {
    const fieldsJson = JSON.stringify(syntheticCatalog.synthetic_crm.account);
    expect(fieldsJson).toMatch(/renewal_date/);
  });
});
