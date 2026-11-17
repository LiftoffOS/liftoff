// Layer precedence (DESIGN-001):
//   1. CONNECTOR_ROLE_HINTS (this map) — highest priority. Connector identity
//      is a reliable signal: a Salesforce record is inherently sales-scoped
//      regardless of what the classifier infers from the text.
//   2. classifier suggestedLayer — LLM inference from content. Overrides default
//      when the connector is not in the map and the content signals a role scope.
//   3. 'global' — default when neither hint nor classifier suggests a role.
//
// When to add an entry: new connector with inherently dept-scoped content where
// the classifier produces wrong-layer results in practice. Do not add entries
// speculatively — the classifier handles unlisted connectors well in the common
// case (documents, notes, general messages).

export const CONNECTOR_ROLE_HINTS: Record<string, string> = {
  // Why: CRM/support/ops connectors have dept-scoped
  //   content that the LLM reliably mis-classifies as global; the role
  //   hint anchors the layer so memories from these sources land in the
  //   correct role-scoped bucket and don't pollute global memory.
  salesforce: 'sales',
  hubspot: 'sales',
  intercom: 'support',
  zendesk: 'support',
  sentry: 'engineering',
  datadog: 'engineering',
};
