import type { MemoryType } from './types';

export const MEMORY_TYPE_TTL_DAYS: Record<MemoryType, number> = {
  CONTEXT:                30,
  PREFERENCE:             90,
  CONVENTION:            180,
  GOTCHA:                365,
  ARCHITECTURAL_DECISION: 365,
};

export function computeExpiresAt(memoryType: MemoryType): string {
  const days = MEMORY_TYPE_TTL_DAYS[memoryType];
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
