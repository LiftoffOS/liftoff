// Static smoke test: the distill-time structural analyzer must not reject
// any catalog template's static defaultTriggerConfig.
//
// At runtime the LLM may add reactiveSubscriptions / companionCrons that
// reference fields outside the bound connectors' published surface — that's
// the analyzer's job and the retry loop catches it. This test only asserts
// that what TEMPLATES ship statically is structurally valid against a
// permissive fixture catalog. If a future template ships a static
// reactiveSubscription with a ghost-field predicate, this test fails fast
// at PR time instead of being caught only by an operator running redistill
// against dev.
//
// Operator-side validation (full LLM round-trip against dev tenants) is
// `POST /api/internal-agents/redistill-all` — documented in the redistill
// service. This static test is the cheap CI guardrail beneath it.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { ConnectorCatalogResponse, ConnectorDef } from '@liftoffos/connector-types';
import type { AgentTemplate, ConnectorRequirement } from '@liftoffos/shared-types';
import { agentTemplateZodSchema } from '../../agent-templates/validator';
import {
  analyzeTriggerConfig,
  asCatalogResponse,
  hasBlockingViolations,
} from '../trigger-config-analyzer';
import type { DistillOutput } from '../distill-service';

const CATALOG_DIR = path.join(__dirname, '..', '..', 'agent-templates', 'catalog');

function loadAllTemplates(): Array<{ template: AgentTemplate; filename: string }> {
  const out: Array<{ template: AgentTemplate; filename: string }> = [];
  const files = fs.readdirSync(CATALOG_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  for (const filename of files) {
    const raw = yaml.load(fs.readFileSync(path.join(CATALOG_DIR, filename), 'utf-8'));
    const parsed = agentTemplateZodSchema.safeParse(raw);
    if (parsed.success) {
      out.push({ template: parsed.data as AgentTemplate, filename });
    }
  }
  return out;
}

// Build a permissive fixture catalog: every connector type the template
// references gets a schema covering the field paths the template's static
// triggerConfig actually uses. Empty maps would falsely reject under strict
// Rule 2 — we want to catch CONFIG bugs in templates, not exercise the
// fail-strict path here.
function fixtureCatalogForTemplate(
  template: AgentTemplate,
  connectorTypesForCapability: (capability: string) => string[],
): ConnectorCatalogResponse {
  const bound = new Set<string>();
  const collect = (req: ConnectorRequirement) => {
    if (req.connectorType) bound.add(req.connectorType);
    if (req.capability) {
      for (const t of connectorTypesForCapability(req.capability)) bound.add(t);
    }
  };
  for (const req of template.requiredConnectors) collect(req);
  for (const req of template.optionalConnectors) collect(req);

  // Extract every leaf path the static triggerConfig predicate references.
  const staticPaths = extractAllPaths(template.defaultTriggerConfig);
  // Synthesize a single "Entity" type per bound connector that declares
  // every static-path leaf as a property. This proves "if the template's
  // static config is internally consistent against ITS OWN named fields,
  // the analyzer passes."
  const props: Record<string, { type: string }> = {};
  for (const p of staticPaths) {
    const leaf = p.split('.').pop() ?? p;
    props[leaf] = { type: 'string' };
  }
  // Always include an id field per the normalizer convention.
  props.id = { type: 'string' };

  const connectors: ConnectorDef[] = [...bound].map(type => ({
    type,
    displayName: type,
    category: 'crm' as ConnectorDef['category'],
    status: 'available' as ConnectorDef['status'],
    auth: { kind: 'none' } as ConnectorDef['auth'],
    entitySchemas: {
      Entity: { type: 'object', properties: { ...props } },
    },
  }));
  return asCatalogResponse(connectors);
}

function extractAllPaths(triggerConfig: unknown): string[] {
  const out: string[] = [];
  function walkFilter(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n.path === 'string') out.push(n.path);
    if (Array.isArray(n.operands)) for (const c of n.operands) walkFilter(c);
    if (n.operand) walkFilter(n.operand);
  }
  const tc = triggerConfig as {
    reactiveSubscriptions?: Array<{ filter?: unknown }>;
    companionCrons?: Array<{ objective?: string }>;
  };
  for (const sub of tc?.reactiveSubscriptions ?? []) walkFilter(sub.filter);
  return out;
}

const fakeTemplateOutput = (template: AgentTemplate): DistillOutput => ({
  agentType: 'agent',
  summary: 'fixture',
  systemPrompt: 'fixture',
  userInstructions: 'fixture',
  instructionsMd: null,
  triggerConfig: template.defaultTriggerConfig as DistillOutput['triggerConfig'],
  skills: [],
  capabilityTier: 'connector_only',
});

const ALL = loadAllTemplates();

describe('Distill structural analyzer — static smoke against catalog templates', () => {
  it('loads every template successfully', () => {
    expect(ALL.length).toBeGreaterThan(0);
  });

  describe.each(ALL.map(({ template, filename }) => [filename, template]) as [string, AgentTemplate][])(
    'template %s',
    (_filename, template) => {
      it('default triggerConfig produces no blocking analyzer violations', () => {
        const { connectorTypesForCapability } = require('../../connectors/connector-service-cache') as typeof import('../../connectors/connector-service-cache');
        const catalog = fixtureCatalogForTemplate(template, connectorTypesForCapability);
        const boundTypes = new Set(catalog.connectors.map(c => c.type));
        const violations = analyzeTriggerConfig(fakeTemplateOutput(template), boundTypes, catalog);
        if (hasBlockingViolations(violations)) {
          // Print the violation list so the failure shows WHICH rule fired.
          throw new Error(
            `Template "${template.id}" produces blocking analyzer violations on its defaultTriggerConfig:\n` +
            JSON.stringify(violations.filter(v => v.severity === 'reject'), null, 2),
          );
        }
        expect(hasBlockingViolations(violations)).toBe(false);
      });
    },
  );
});
