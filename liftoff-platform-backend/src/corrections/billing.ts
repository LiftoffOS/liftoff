// Correction Billing Integration
// Per implementation plan: Financial correction tracking for CFO audit compliance

import { correctionRepository } from './repository';
import { publishEvent } from '../events/publisher';
import { AgentAuditLog } from '../agent-audit-logs/types';
import { CorrectionType, FinancialCorrection, InsertFinancialCorrectionInput } from './types';
import { log } from '../infrastructure/logging';

/**
 * Handle financial correction - record in financial_corrections table
 * and emit billing event for downstream processing
 */
export async function handleFinancialCorrection(
  tenantId: string,
  originalAction: AgentAuditLog,
  correctionAuditLogId: string,
  correctionType: CorrectionType
): Promise<FinancialCorrection | null> {
  // Only process financial correction types
  if (!['refund', 'credit', 'void'].includes(correctionType)) {
    return null;
  }

  // Extract amount from original action
  const amount = extractAmount(originalAction);
  if (amount === null) {
    log.warn({
      tenantId,
      originalActionId: originalAction.id,
      action: originalAction.action,
    }, 'Could not extract amount from original action for financial correction');
    return null;
  }

  // Insert financial correction record
  const input: InsertFinancialCorrectionInput = {
    tenantId,
    originalAuditLogId: originalAction.id,
    correctionAuditLogId,
    correctionType,
    amountCents: Math.round(amount * 100), // Convert to cents
    currency: extractCurrency(originalAction) || 'usd',
    reason: 'correction_requested',
  };

  const financialCorrection = await correctionRepository.insertFinancialCorrection(input);

  // Emit billing event for downstream processing
  await publishEvent({
    entityType: 'billing',
    entityId: correctionAuditLogId,
    eventType: 'refund.processed',
    entityVersion: 1,
    eventVersion: 1,
    tenantId,
    payload: {
      originalChargeId: extractResourceId(originalAction.outputSummary),
      amount,
      currency: input.currency,
      correctionAuditLogId,
      financialCorrectionId: financialCorrection.id,
      correctionType,
    },
  });

  log.info({
    tenantId,
    financialCorrectionId: financialCorrection.id,
    originalActionId: originalAction.id,
    correctionType,
    amountCents: input.amountCents,
    currency: input.currency,
  }, 'Financial correction recorded');

  return financialCorrection;
}

/**
 * Extract amount from original action input args or output summary
 */
function extractAmount(action: AgentAuditLog): number | null {
  // Check inputArgs for amount
  if (action.inputArgs) {
    if (typeof action.inputArgs.amount === 'number') {
      return action.inputArgs.amount;
    }
    if (typeof action.inputArgs.amount_cents === 'number') {
      return action.inputArgs.amount_cents / 100;
    }
    // Stripe uses cents
    if (typeof action.inputArgs.unit_amount === 'number') {
      return action.inputArgs.unit_amount / 100;
    }
  }

  // Try to extract from output summary
  if (action.outputSummary) {
    // Try to find amount in output
    const amountMatch = action.outputSummary.match(/amount[":]*\s*(\d+(?:\.\d{2})?)/i);
    if (amountMatch) {
      return parseFloat(amountMatch[1]);
    }
  }

  return null;
}

/**
 * Extract currency from original action input args
 */
function extractCurrency(action: AgentAuditLog): string | null {
  if (action.inputArgs && typeof action.inputArgs.currency === 'string') {
    return action.inputArgs.currency.toLowerCase();
  }
  return null;
}

/**
 * Extract resource ID from output summary
 */
function extractResourceId(outputSummary: string | null): string | null {
  if (!outputSummary) return null;

  // Try common ID patterns
  const patterns = [
    /id[":]*\s*["']?([a-zA-Z0-9_-]+)["']?/i,
    /charge_id[":]*\s*["']?(ch_[a-zA-Z0-9]+)["']?/i,
    /payment_intent[":]*\s*["']?(pi_[a-zA-Z0-9]+)["']?/i,
    /subscription[":]*\s*["']?(sub_[a-zA-Z0-9]+)["']?/i,
  ];

  for (const pattern of patterns) {
    const match = outputSummary.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

