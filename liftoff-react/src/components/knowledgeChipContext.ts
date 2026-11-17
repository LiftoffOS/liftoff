import { createContext } from 'react'

export interface ChipContextValue {
  availableItemIds: Set<string>     // IDs currently in knowledgeItems
  boundConnectorIds: Set<string>    // currently-bound connector UUIDs
  itemConnectorMap: Map<string, string | null>  // itemId → connectorId (null for manual)
}

const EMPTY_CHIP_CONTEXT: ChipContextValue = {
  availableItemIds: new Set(),
  boundConnectorIds: new Set(),
  itemConnectorMap: new Map(),
}

export const KnowledgeChipContext = createContext<ChipContextValue>(EMPTY_CHIP_CONTEXT)
