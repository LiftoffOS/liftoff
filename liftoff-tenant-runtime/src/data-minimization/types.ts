// Data Minimization Types
// Per Section 21: GDPR data minimization at ingestion

export interface MinimizationPolicy {
  id: string;
  tenantId: string;
  entityType: string;
  enabled: boolean;
  rules: MinimizationRule[];
  createdAt: Date;
  updatedAt: Date;
}

export interface MinimizationRule {
  fieldPath: string;
  action: MinimizationAction;
  dataCategory: DataCategory;
  condition?: MinimizationCondition;
}

export type MinimizationAction =
  | 'keep'           // Keep as-is
  | 'redact'         // Replace with [REDACTED]
  | 'hash'           // One-way hash
  | 'tokenize'       // Reversible tokenization
  | 'truncate'       // Truncate to N characters
  | 'mask'           // Mask partial content (e.g., ****1234)
  | 'remove'         // Remove the field entirely
  | 'aggregate';     // Aggregate instead of individual values

export type DataCategory =
  | 'identifier'     // Names, usernames, IDs
  | 'contact'        // Email, phone, address
  | 'financial'      // Payment info, account numbers
  | 'health'         // Medical information
  | 'biometric'      // Biometric data
  | 'location'       // GPS, IP addresses
  | 'behavioral'     // Browsing history, preferences
  | 'sensitive'      // Racial, political, religious
  | 'general';       // Non-sensitive PII

export interface MinimizationCondition {
  type: 'region' | 'purpose' | 'consent' | 'retention';
  operator: 'equals' | 'not_equals' | 'in' | 'not_in' | 'expired';
  value: string | string[];
}

export interface MinimizationResult {
  originalFieldCount: number;
  minimizedFieldCount: number;
  redactedFields: string[];
  removedFields: string[];
  hashedFields: string[];
  minimizedData: Record<string, unknown>;
}

export interface FieldClassification {
  fieldPath: string;
  dataCategory: DataCategory;
  isPII: boolean;
  confidence: number;
  suggestedAction: MinimizationAction;
}

// Default rules for common connectors
export interface ConnectorDefaultRules {
  connectorType: string;
  rules: MinimizationRule[];
}
