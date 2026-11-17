// Feature Flag Types

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  valueNum: number | null;
  tenantOverrides: Record<string, boolean>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFlagInput {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  valueNum?: number | null;
}

export interface UpdateFlagInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  valueNum?: number | null;
  tenantOverrides?: Record<string, boolean>;
}
