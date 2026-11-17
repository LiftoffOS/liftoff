// scrapingbee overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const SCRAPINGBEE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  SCRAPINGBEE_HTML_FETCH: { stableName: 'fetch_html', categoryOverrides: ["read"] },
  SCRAPINGBEE_DATA_EXTRACTION: { stableName: 'extract_data', categoryOverrides: ["read"] },
  SCRAPINGBEE_SCRAPING_BEE_PROXY_MODE: { stableName: 'proxy_fetch', categoryOverrides: ["read"] },
  SCRAPINGBEE_USAGE_STATS: { stableName: 'usage_stats', categoryOverrides: ["read"] },
};

export const SCRAPINGBEE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
