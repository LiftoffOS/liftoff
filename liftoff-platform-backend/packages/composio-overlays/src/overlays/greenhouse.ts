// greenhouse overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GREENHOUSE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GREENHOUSE_LIST_CANDIDATES: { stableName: 'list_candidates', categoryOverrides: ["read"] },
  GREENHOUSE_LIST_APPLICATIONS: { stableName: 'list_applications', categoryOverrides: ["read"] },
  GREENHOUSE_LIST_JOBS: { stableName: 'list_jobs', categoryOverrides: ["read"] },
  GREENHOUSE_LIST_INTERVIEWS: { stableName: 'list_interviews', categoryOverrides: ["read"] },
  GREENHOUSE_LIST_OFFERS: { stableName: 'list_offers', categoryOverrides: ["read"] },
  GREENHOUSE_LIST_OPENINGS: { stableName: 'list_openings', categoryOverrides: ["read"] },
  GREENHOUSE_LIST_JOB_NOTES: { stableName: 'list_job_notes', categoryOverrides: ["read"] },
  GREENHOUSE_CREATE_CANDIDATE: { stableName: 'create_candidate', categoryOverrides: ["write"] },
  GREENHOUSE_CREATE_APPLICATION: { stableName: 'create_application', categoryOverrides: ["write"] },
  GREENHOUSE_CREATE_NOTE: { stableName: 'create_candidate_note', categoryOverrides: ["write"] },
  GREENHOUSE_CREATE_JOB: { stableName: 'create_job', categoryOverrides: ["write"] },
  GREENHOUSE_APPLY_CANDIDATE_TAG: { stableName: 'apply_candidate_tag', categoryOverrides: ["write"] },
};

export const GREENHOUSE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
