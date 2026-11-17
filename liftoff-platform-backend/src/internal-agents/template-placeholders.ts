/**
 * Resolving a template's placeholders into the text an agent STORES.
 *
 * `applyTemplatePicks` has always run on the way into the distillation prompt,
 * which left the stored `responsibilities` and `additionalContext` holding the
 * raw `{{pick:...}}`. Two things followed, and the second is the serious one:
 *
 *  - The edit screen showed a person our own placeholder syntax in the field
 *    they were being invited to rewrite.
 *  - Picks are not persisted anywhere else, so a later redistill had nothing to
 *    resolve them from. It substituted the generic fallback instead, and an
 *    agent told to post to "#deal-room" quietly began saying "your deal
 *    channel" — no error, a well-formed prompt, and the destination gone.
 *
 * Resolving at the point of storage fixes both, because the stored prose then
 * carries the destination itself and every later read starts from it.
 */
import { unpickedPhraseFor } from '../agent-templates/platform-destinations';
import { getTemplate } from '../agent-templates/loader';
import { connectorTypesForRequirement } from '../agent-templates/connector-capabilities';
import { applyTemplatePicks } from './distill-service';
import { destinationRule, type DestinationPick } from './destination-rule';
import { log } from '../infrastructure/logging';

/** One declaration, in destination-rule.ts. */
export type TemplatePick = DestinationPick;

interface AgentText {
  responsibilities?: string;
  additionalContext?: string;
}

/** The template's fallback phrase for each declared object, by object id.
 *
 *  An unanswered optional pick resolves to this rather than to nothing: it is
 *  the same phrase the gallery rendered before anyone hired, so the sentence a
 *  person read is the sentence the team is given. */
function fallbacksFor(templateId: string): Record<string, string> | undefined {
  const template = getTemplate(templateId);
  if (!template) {
    // A template that has been renamed or withdrawn. Leaving the text raw would
    // put braces on a screen, so the caller still substitutes — with no
    // fallbacks the shared default phrase applies.
    log.warn({ templateId }, 'resolveTemplatePlaceholders: template not found; resolving with defaults only');
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const req of [...template.requiredConnectors, ...(template.optionalConnectors ?? [])]) {
    for (const obj of req.objects ?? []) {
      // A platform-floored destination reads as the platform's own surface
      // rather than a phrase naming nothing.
      const unpicked = unpickedPhraseFor(obj);
      if (unpicked) out[obj.id] = unpicked;
    }
  }
  return out;
}

/** `{{connector:<requirement id>}}` → the clause that matches what was actually
 *  bound.
 *
 *  Unbound resolves to `whenUnbound`, which is written as though the tool was
 *  never part of the job. That is the whole point: a hired team should read one
 *  instruction, not an instruction plus an explanation of what to do when the
 *  tool it does not have is missing. It also removes a branch the model would
 *  otherwise evaluate on every run.
 *
 *  An unresolvable reference is left to `whenUnbound` rather than to the raw
 *  placeholder, because braces reaching a system prompt is the failure this
 *  whole mechanism exists to remove. */
function applyConnectorProse(
  text: string,
  templateId: string,
  boundConnectorTypes: ReadonlySet<string> | undefined,
): string {
  if (!text) return text;
  const template = getTemplate(templateId);
  if (!template) return text;
  const byId = new Map(
    (template.optionalConnectors ?? []).map((req) => [req.id, req] as const),
  );
  return text.replace(/\{\{\s*connector:([a-z][a-z0-9-]*)\s*\}\}/g, (_m, reqId: string) => {
    const req = byId.get(reqId);
    if (!req?.prose) {
      log.warn({ templateId, reqId }, 'applyConnectorProse: no prose variants declared; dropping reference');
      return '';
    }
    const satisfied = connectorTypesForRequirement(req).some((t) => boundConnectorTypes?.has(t));
    return satisfied ? req.prose.whenBound : req.prose.whenUnbound;
  });
}

export function resolveTemplatePlaceholders(
  templateId: string,
  text: AgentText,
  picks: Record<string, TemplatePick> | undefined,
  boundConnectorTypes?: ReadonlySet<string>,
): AgentText {
  const fallbacks = fallbacksFor(templateId);
  // Connector variants FIRST: an unbound connector's clause is dropped whole,
  // so its picks never reach the pick pass and cannot leave a destination
  // phrase behind for a tool the team was not given.
  const resolve = (t: string) =>
    applyTemplatePicks(applyConnectorProse(t, templateId, boundConnectorTypes), picks, fallbacks);
  // Appended to additionalContext, not responsibilities: it is a fact about
  // this hire's workspace rather than a thing the team does.
  const rule = destinationRule(picks);
  const context = text.additionalContext ? resolve(text.additionalContext) : text.additionalContext;
  return {
    responsibilities: text.responsibilities ? resolve(text.responsibilities) : text.responsibilities,
    additionalContext: context ? `${context}${rule}` : context,
  };
}
