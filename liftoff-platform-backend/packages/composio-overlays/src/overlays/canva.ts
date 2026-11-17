// canva overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const CANVA_OVERLAYS: Record<string, ComposioToolOverlay> = {
  CANVA_LIST_USER_DESIGNS: { stableName: 'list_designs', categoryOverrides: ["read"] },
  CANVA_FETCH_DESIGN_METADATA_AND_ACCESS_INFORMATION: { stableName: 'get_design', categoryOverrides: ["read"] },
  CANVA_CREATE_CANVA_DESIGN_WITH_OPTIONAL_ASSET: { stableName: 'create_design', categoryOverrides: ["write"] },
  CANVA_LIST_DESIGN_PAGES_WITH_PAGINATION: { stableName: 'list_design_pages', categoryOverrides: ["read"] },
  CANVA_INITIATES_CANVA_DESIGN_EXPORT_JOB: { stableName: 'export_design', categoryOverrides: ["read"] },
  CANVA_GET_DESIGN_EXPORT_JOB_RESULT: { stableName: 'get_export_result', categoryOverrides: ["read"] },
  CANVA_ACCESS_USER_SPECIFIC_BRAND_TEMPLATES_LIST: { stableName: 'list_brand_templates', categoryOverrides: ["read"] },
  CANVA_INITIATE_CANVA_DESIGN_AUTOFILL_JOB: { stableName: 'autofill_design', categoryOverrides: ["read"] },
  CANVA_RETRIEVE_DESIGN_AUTOFILL_JOB_STATUS: { stableName: 'get_autofill_status', categoryOverrides: ["read"] },
  CANVA_LIST_FOLDER_ITEMS_BY_TYPE_WITH_SORTING: { stableName: 'list_folder_items', categoryOverrides: ["read"] },
  CANVA_CREATE_USER_OR_SUB_FOLDER: { stableName: 'create_folder', categoryOverrides: ["write"] },
  CANVA_FETCH_CURRENT_USER_DETAILS: { stableName: 'get_current_user', categoryOverrides: ["read"] },
};

export const CANVA_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
