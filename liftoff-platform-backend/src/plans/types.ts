// Billing Plan Types
// Per Section 13: Control plane owns plans

export interface Plan {
  id: string;
  name: string;
  description: string;
  stripePriceId: string;
  includedCredits: number;
  overageAllowed: boolean;
  overageRate: number; // cents per credit
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePlanInput {
  name: string;
  description: string;
  stripePriceId: string;
  includedCredits: number;
  overageAllowed: boolean;
  overageRate: number;
}

export interface UpdatePlanInput {
  name?: string;
  description?: string;
  stripePriceId?: string;
  includedCredits?: number;
  overageAllowed?: boolean;
  overageRate?: number;
  status?: 'active' | 'archived';
}
