// Data Minimization Service
// Per Section 21: GDPR data minimization at ingestion

import * as crypto from 'crypto';
import { logger } from '../infrastructure/logging';
import {
  MinimizationPolicy,
  MinimizationRule,
  MinimizationAction,
  MinimizationResult,
  DataCategory,
  FieldClassification,
  ConnectorDefaultRules,
} from './types';

export class DataMinimizationService {
  private policies: Map<string, MinimizationPolicy> = new Map();
  private hashSecret: string;

  constructor() {
    this.hashSecret = process.env.DATA_HASH_SECRET || 'default-hash-secret';
    this.initializeDefaultRules();
  }

  // Initialize default PII detection patterns
  private piiPatterns: Record<DataCategory, RegExp[]> = {
    identifier: [
      /name/i,
      /username/i,
      /user_id/i,
      /account_id/i,
      /customer_id/i,
      /ssn/i,
      /social_security/i,
      /passport/i,
      /driver_license/i,
    ],
    contact: [
      /email/i,
      /phone/i,
      /address/i,
      /city/i,
      /postal/i,
      /zip/i,
      /street/i,
      /mobile/i,
      /fax/i,
    ],
    financial: [
      /card_number/i,
      /credit_card/i,
      /bank_account/i,
      /routing/i,
      /iban/i,
      /cvv/i,
      /expiry/i,
      /payment/i,
    ],
    health: [
      /medical/i,
      /health/i,
      /diagnosis/i,
      /prescription/i,
      /blood/i,
      /allergies/i,
    ],
    biometric: [
      /fingerprint/i,
      /face_id/i,
      /retina/i,
      /voice_print/i,
      /dna/i,
    ],
    location: [
      /latitude/i,
      /longitude/i,
      /geo/i,
      /gps/i,
      /ip_address/i,
      /location/i,
      /coordinates/i,
    ],
    behavioral: [
      /browser/i,
      /cookie/i,
      /tracking/i,
      /preferences/i,
      /history/i,
    ],
    sensitive: [
      /race/i,
      /ethnicity/i,
      /religion/i,
      /political/i,
      /sexual_orientation/i,
      /union_membership/i,
    ],
    general: [],
  };

  // Default rules for common connector types
  private defaultConnectorRules: ConnectorDefaultRules[] = [
    {
      connectorType: 'salesforce',
      rules: [
        { fieldPath: '*.email', action: 'keep', dataCategory: 'contact' },
        { fieldPath: '*.phone', action: 'mask', dataCategory: 'contact' },
        { fieldPath: '*.ssn', action: 'redact', dataCategory: 'identifier' },
        { fieldPath: '*.credit_card', action: 'remove', dataCategory: 'financial' },
      ],
    },
    {
      connectorType: 'hubspot',
      rules: [
        { fieldPath: '*.email', action: 'keep', dataCategory: 'contact' },
        { fieldPath: '*.phone', action: 'mask', dataCategory: 'contact' },
        { fieldPath: '*.ip_address', action: 'hash', dataCategory: 'location' },
      ],
    },
    {
      connectorType: 'slack',
      rules: [
        { fieldPath: '*.email', action: 'keep', dataCategory: 'contact' },
        { fieldPath: '*.phone', action: 'mask', dataCategory: 'contact' },
        { fieldPath: '*.message_content', action: 'keep', dataCategory: 'general' },
      ],
    },
    {
      connectorType: 'google_mail',
      rules: [
        { fieldPath: '*.email', action: 'keep', dataCategory: 'contact' },
        { fieldPath: '*.body', action: 'keep', dataCategory: 'general' },
        { fieldPath: '*.attachments.*.content', action: 'remove', dataCategory: 'general' },
      ],
    },
  ];

  private initializeDefaultRules(): void {
    // Load default rules for each connector type
    for (const connectorRules of this.defaultConnectorRules) {
      const policyId = `default-${connectorRules.connectorType}`;
      this.policies.set(policyId, {
        id: policyId,
        tenantId: 'default',
        entityType: connectorRules.connectorType,
        enabled: true,
        rules: connectorRules.rules,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  // Main minimization entry point
  async minimizeData(
    tenantId: string,
    connectorType: string,
    data: Record<string, unknown>
  ): Promise<MinimizationResult> {
    const policy = await this.getPolicy(tenantId, connectorType);

    if (!policy || !policy.enabled) {
      // No policy or disabled - apply auto-detection
      return this.applyAutoMinimization(data);
    }

    return this.applyPolicy(data, policy);
  }

  // Get policy for tenant/connector
  async getPolicy(tenantId: string, entityType: string): Promise<MinimizationPolicy | null> {
    // Check tenant-specific policy first
    const tenantPolicyId = `${tenantId}-${entityType}`;
    if (this.policies.has(tenantPolicyId)) {
      return this.policies.get(tenantPolicyId)!;
    }

    // Fall back to default for connector type
    const defaultPolicyId = `default-${entityType}`;
    if (this.policies.has(defaultPolicyId)) {
      return this.policies.get(defaultPolicyId)!;
    }

    return null;
  }

  // Set policy for tenant
  setPolicy(policy: MinimizationPolicy): void {
    const policyId = `${policy.tenantId}-${policy.entityType}`;
    this.policies.set(policyId, policy);

    logger.info('Set minimization policy', {
      tenantId: policy.tenantId,
      entityType: policy.entityType,
      ruleCount: policy.rules.length,
    });
  }

  // Apply policy to data
  private applyPolicy(
    data: Record<string, unknown>,
    policy: MinimizationPolicy
  ): MinimizationResult {
    const result: MinimizationResult = {
      originalFieldCount: this.countFields(data),
      minimizedFieldCount: 0,
      redactedFields: [],
      removedFields: [],
      hashedFields: [],
      minimizedData: {},
    };

    result.minimizedData = this.processObject(data, policy.rules, '', result);
    result.minimizedFieldCount = this.countFields(result.minimizedData);

    return result;
  }

  // Process object recursively
  private processObject(
    obj: Record<string, unknown>,
    rules: MinimizationRule[],
    path: string,
    result: MinimizationResult
  ): Record<string, unknown> {
    const processed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;
      const rule = this.findMatchingRule(fieldPath, rules);

      if (value === null || value === undefined) {
        processed[key] = value;
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        processed[key] = this.processObject(
          value as Record<string, unknown>,
          rules,
          fieldPath,
          result
        );
      } else if (Array.isArray(value)) {
        processed[key] = value.map((item, index) => {
          if (typeof item === 'object' && item !== null) {
            return this.processObject(
              item as Record<string, unknown>,
              rules,
              `${fieldPath}[${index}]`,
              result
            );
          }
          return this.applyAction(item, rule?.action || 'keep', fieldPath, result);
        });
      } else {
        const action = rule?.action || this.detectAction(key, value);
        processed[key] = this.applyAction(value, action, fieldPath, result);
      }
    }

    return processed;
  }

  // Find matching rule for field path
  private findMatchingRule(fieldPath: string, rules: MinimizationRule[]): MinimizationRule | null {
    for (const rule of rules) {
      const pattern = rule.fieldPath
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\[\*\]/g, '\\[\\d+\\]');

      const regex = new RegExp(`^${pattern}$`);
      if (regex.test(fieldPath)) {
        return rule;
      }
    }
    return null;
  }

  // Apply minimization action
  private applyAction(
    value: unknown,
    action: MinimizationAction,
    fieldPath: string,
    result: MinimizationResult
  ): unknown {
    if (value === null || value === undefined) return value;

    switch (action) {
      case 'keep':
        return value;

      case 'redact':
        result.redactedFields.push(fieldPath);
        return '[REDACTED]';

      case 'hash':
        result.hashedFields.push(fieldPath);
        return this.hashValue(String(value));

      case 'tokenize':
        return this.tokenize(String(value));

      case 'truncate':
        return String(value).substring(0, 50) + '...';

      case 'mask':
        return this.maskValue(String(value));

      case 'remove':
        result.removedFields.push(fieldPath);
        return undefined;

      case 'aggregate':
        return '[AGGREGATED]';

      default:
        return value;
    }
  }

  // Hash value with HMAC
  private hashValue(value: string): string {
    return crypto
      .createHmac('sha256', this.hashSecret)
      .update(value)
      .digest('hex')
      .substring(0, 16);
  }

  // Tokenize value (reversible with key)
  private tokenize(value: string): string {
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      crypto.scryptSync(this.hashSecret, 'salt', 32),
      Buffer.alloc(16, 0)
    );
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `tok_${encrypted.substring(0, 16)}`;
  }

  // Mask value (e.g., email@example.com -> e***@example.com)
  private maskValue(value: string): string {
    // Email pattern
    if (value.includes('@')) {
      const [local, domain] = value.split('@');
      return `${local[0]}***@${domain}`;
    }

    // Phone pattern (last 4 digits)
    if (/^\+?[\d\s-]{10,}$/.test(value)) {
      return `***-***-${value.slice(-4)}`;
    }

    // Generic: show first and last char
    if (value.length > 4) {
      return `${value[0]}${'*'.repeat(value.length - 2)}${value.slice(-1)}`;
    }

    return '****';
  }

  // Auto-detect action based on field name
  private detectAction(fieldName: string, value: unknown): MinimizationAction {
    const category = this.classifyField(fieldName, value);

    switch (category) {
      case 'financial':
      case 'health':
      case 'biometric':
      case 'sensitive':
        return 'redact';

      case 'contact':
        return 'mask';

      case 'location':
        return 'hash';

      case 'identifier':
        return 'keep'; // Usually needed for functionality

      default:
        return 'keep';
    }
  }

  // Classify field category
  private classifyField(fieldName: string, _value: unknown): DataCategory {
    for (const [category, patterns] of Object.entries(this.piiPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(fieldName)) {
          return category as DataCategory;
        }
      }
    }
    return 'general';
  }

  // Auto-minimization for unknown connectors
  private applyAutoMinimization(data: Record<string, unknown>): MinimizationResult {
    const result: MinimizationResult = {
      originalFieldCount: this.countFields(data),
      minimizedFieldCount: 0,
      redactedFields: [],
      removedFields: [],
      hashedFields: [],
      minimizedData: {},
    };

    result.minimizedData = this.autoProcessObject(data, '', result);
    result.minimizedFieldCount = this.countFields(result.minimizedData);

    return result;
  }

  // Auto-process object with PII detection
  private autoProcessObject(
    obj: Record<string, unknown>,
    path: string,
    result: MinimizationResult
  ): Record<string, unknown> {
    const processed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;

      if (value === null || value === undefined) {
        processed[key] = value;
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        processed[key] = this.autoProcessObject(
          value as Record<string, unknown>,
          fieldPath,
          result
        );
      } else if (Array.isArray(value)) {
        processed[key] = value.map((item, index) => {
          if (typeof item === 'object' && item !== null) {
            return this.autoProcessObject(
              item as Record<string, unknown>,
              `${fieldPath}[${index}]`,
              result
            );
          }
          const action = this.detectAction(key, item);
          return this.applyAction(item, action, `${fieldPath}[${index}]`, result);
        });
      } else {
        const action = this.detectAction(key, value);
        processed[key] = this.applyAction(value, action, fieldPath, result);
      }
    }

    return processed;
  }

  // Count fields in object
  private countFields(obj: Record<string, unknown>): number {
    let count = 0;
    for (const value of Object.values(obj)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'object' && !Array.isArray(value)) {
        count += this.countFields(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        count += value.length;
      } else {
        count++;
      }
    }
    return count;
  }

  // Classify fields in data for audit/reporting
  classifyFields(data: Record<string, unknown>): FieldClassification[] {
    const classifications: FieldClassification[] = [];
    this.classifyRecursive(data, '', classifications);
    return classifications;
  }

  private classifyRecursive(
    obj: Record<string, unknown>,
    path: string,
    classifications: FieldClassification[]
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        this.classifyRecursive(value as Record<string, unknown>, fieldPath, classifications);
      } else {
        const category = this.classifyField(key, value);
        const isPII = category !== 'general';

        classifications.push({
          fieldPath,
          dataCategory: category,
          isPII,
          confidence: isPII ? 0.8 : 0.5,
          suggestedAction: this.detectAction(key, value),
        });
      }
    }
  }
}

export const dataMinimizationService = new DataMinimizationService();
