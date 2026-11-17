/** Types for sync-connections-catalog.mjs, so its parser can be tested from TypeScript. */
export interface SnapshotApp {
  id: string
  name: string
  status: 'available' | 'coming_soon'
}

export interface SnapshotCategory {
  label: string
  apps: SnapshotApp[]
}

export interface ConnectionsSnapshot {
  generatedFrom: string | null
  categories: SnapshotCategory[]
}

export function parseConnectorsMd(md: string): ConnectionsSnapshot
