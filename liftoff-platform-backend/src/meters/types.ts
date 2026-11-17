// Meter Definition Types
// Per Section 13: Control plane owns meter definitions

export interface MeterDefinition {
  id: string;
  name: string;
  description: string;
  stripeMeterId: string | null;
  unit: string;
  aggregationType: 'sum' | 'max' | 'last' | 'count';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMeterInput {
  name: string;
  description: string;
  stripeMeterId?: string;
  unit: string;
  aggregationType: 'sum' | 'max' | 'last' | 'count';
}

export interface UpdateMeterInput {
  name?: string;
  description?: string;
  stripeMeterId?: string;
  unit?: string;
  aggregationType?: 'sum' | 'max' | 'last' | 'count';
}
