// Correction Budget
// Per implementation plan: Correction budget tracking per tenant

import { correctionRepository } from './repository';
import { BudgetCheckResult, CorrectionBudget } from './types';

/**
 * Check if tenant has correction budget remaining and deduct if allowed
 * @deprecated Use atomicCheckAndDeductBudget for race-condition-free operation
 */
export async function checkAndDeductBudget(tenantId: string): Promise<BudgetCheckResult> {
  const budget = await correctionRepository.getBudget(tenantId);

  // No budget configured = unlimited
  if (!budget) {
    return { allowed: true };
  }

  // Check if we need to reset for new period
  if (isNewPeriod(budget.periodStart, budget.budgetPeriod)) {
    const newPeriodStart = getNewPeriodStart(budget.budgetPeriod);
    await correctionRepository.resetBudget(tenantId, newPeriodStart);

    // After reset, budget is available
    const remaining = budget.budgetLimit ? budget.budgetLimit - 1 : undefined;
    await correctionRepository.incrementBudgetUsed(tenantId);
    return { allowed: true, remaining };
  }

  // No limit = unlimited
  if (budget.budgetLimit === null) {
    return { allowed: true };
  }

  // Check if budget exhausted
  if (budget.budgetUsed >= budget.budgetLimit) {
    return { allowed: false, remaining: 0 };
  }

  // Deduct and return
  await correctionRepository.incrementBudgetUsed(tenantId);
  return {
    allowed: true,
    remaining: budget.budgetLimit - budget.budgetUsed - 1,
  };
}

/**
 * BE-002: Atomically check and deduct budget
 * Eliminates TOCTOU race condition between check and deduct
 */
export async function atomicCheckAndDeductBudget(tenantId: string): Promise<BudgetCheckResult> {
  const result = await correctionRepository.checkAndDeductBudget(tenantId);
  return {
    allowed: result.allowed,
    remaining: result.remaining ?? undefined,
  };
}

/**
 * Check if budget is available without deducting
 */
export async function checkBudget(tenantId: string): Promise<BudgetCheckResult> {
  const budget = await correctionRepository.getBudget(tenantId);

  if (!budget) {
    return { allowed: true };
  }

  // Check if we need to reset
  if (isNewPeriod(budget.periodStart, budget.budgetPeriod)) {
    // Budget will be reset on next request
    return { allowed: true, remaining: budget.budgetLimit ?? undefined };
  }

  if (budget.budgetLimit === null) {
    return { allowed: true };
  }

  if (budget.budgetUsed >= budget.budgetLimit) {
    return { allowed: false, remaining: 0 };
  }

  return {
    allowed: true,
    remaining: budget.budgetLimit - budget.budgetUsed,
  };
}

/**
 * Check if we're in a new budget period
 */
function isNewPeriod(periodStart: Date, budgetPeriod: string): boolean {
  const now = new Date();

  switch (budgetPeriod) {
    case 'daily':
      return now.getDate() !== periodStart.getDate() ||
        now.getMonth() !== periodStart.getMonth() ||
        now.getFullYear() !== periodStart.getFullYear();

    case 'weekly': {
      // Get start of week for both dates
      const currentWeekStart = getWeekStart(now);
      const periodWeekStart = getWeekStart(periodStart);
      return currentWeekStart.getTime() !== periodWeekStart.getTime();
    }

    case 'monthly':
    default:
      return now.getMonth() !== periodStart.getMonth() ||
        now.getFullYear() !== periodStart.getFullYear();
  }
}

/**
 * Get start of current period
 */
function getNewPeriodStart(budgetPeriod: string): Date {
  const now = new Date();

  switch (budgetPeriod) {
    case 'daily':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    case 'weekly':
      return getWeekStart(now);

    case 'monthly':
    default:
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  }
}

/**
 * Get start of week (Sunday)
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day;
  return new Date(d.getFullYear(), d.getMonth(), diff, 0, 0, 0, 0);
}

/**
 * Get remaining budget info for a tenant
 */
export async function getBudgetInfo(tenantId: string): Promise<{
  configured: boolean;
  budget: CorrectionBudget | null;
  remaining: number | null;
  resetsAt: Date | null;
}> {
  const budget = await correctionRepository.getBudget(tenantId);

  if (!budget) {
    return { configured: false, budget: null, remaining: null, resetsAt: null };
  }

  // Calculate reset time
  const resetsAt = getNextPeriodStart(budget.periodStart, budget.budgetPeriod);

  // Calculate remaining
  const remaining = budget.budgetLimit !== null
    ? Math.max(0, budget.budgetLimit - budget.budgetUsed)
    : null;

  return { configured: true, budget, remaining, resetsAt };
}

/**
 * Get start of next period
 */
function getNextPeriodStart(periodStart: Date, budgetPeriod: string): Date {
  switch (budgetPeriod) {
    case 'daily': {
      const next = new Date(periodStart);
      next.setDate(next.getDate() + 1);
      return new Date(next.getFullYear(), next.getMonth(), next.getDate(), 0, 0, 0, 0);
    }

    case 'weekly': {
      const next = new Date(periodStart);
      next.setDate(next.getDate() + 7);
      return getWeekStart(next);
    }

    case 'monthly':
    default: {
      const next = new Date(periodStart);
      next.setMonth(next.getMonth() + 1);
      return new Date(next.getFullYear(), next.getMonth(), 1, 0, 0, 0, 0);
    }
  }
}
