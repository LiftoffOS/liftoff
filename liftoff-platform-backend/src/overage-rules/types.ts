// Overage Rules Types
// Per Section 13: Control plane owns overage rules

export interface OverageRule {
  id: string;
  tenantId: string;
  planId: string;
  overageRatePerCredit: number; // Decimal rate per credit
  overageCeiling: number | null; // Max overage allowed, null = unlimited
  billingThreshold: number | null; // Amount that triggers billing
  notificationThreshold: number | null; // Amount that triggers notification
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOverageRuleInput {
  tenantId: string;
  planId: string;
  overageRatePerCredit: number;
  overageCeiling?: number;
  billingThreshold?: number;
  notificationThreshold?: number;
}

export interface UpdateOverageRuleInput {
  overageRatePerCredit?: number;
  overageCeiling?: number | null;
  billingThreshold?: number | null;
  notificationThreshold?: number | null;
}
