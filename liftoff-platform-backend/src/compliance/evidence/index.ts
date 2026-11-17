// Compliance Evidence Module
// Per Section 19/20: SOC 2 and GDPR readiness - compliance evidence collection

export * from './types';
export { ComplianceEvidenceService } from './service';
export { evidenceRouter } from './router';
export { AutomatedEvidenceCollector, automatedEvidenceCollector } from './automated-collection';
