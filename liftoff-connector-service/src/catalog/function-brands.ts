// Who a platform-funded function's data comes FROM, for the person paying for
// it: the end brand (Zillow, TikTok, SEC EDGAR), the category the public
// /data-sources page files it under, and a plain name for the call. Served
// next to the prices (function-prices.ts) on the connector-types route, so the
// dashboard's Data Sources page can list sources by brand with the Operating
// Units a call costs.
//
// A brand is never the intermediary that resells the call. The function names
// hide the supplier from the model; this map names the SOURCE for a person,
// and the reseller (Locus, Vaaya, Strale, TikHub and the rest) stays out of
// both the brand and the label. FORBIDDEN_WORDS is that rule, checked by test.
//
// Coverage is by test, not by hope: every function priced in PRICES for a
// covered type either has an entry here or is named in EXCLUDED, so a newly
// priced function fails the suite until someone decides what it is. Strale and
// kadec0 are hand-picked: their data lookups are mapped, their processing and
// utility tools (code review, JSON to CSV, regex, SQL) are excluded, because a
// person comparing data sources is not buying those.

import { LOCUS_DISPATCH } from './generated/locus.js';
import { LOCUS_PARSE_DISPATCH } from './generated/locus-parse.js';
import { LOCUS_PARSE_ALLOWLIST } from './locus-parse-allowlist.js';
import { VAAYA_DISPATCH } from './generated/vaaya.js';
import { TIKHUB_FUNCTIONS } from './generated/tikhub.js';
import { STRALE_FUNCTIONS } from './generated/strale.js';
import { KADEC0_DISPATCH } from './generated/kadec0.js';
import { NASDAQ_FUNCTIONS } from './generated/nasdaq.js';
import { DEFILLAMA_FUNCTIONS } from './generated/defillama.js';
import { YCOMBINATOR_FUNCTIONS } from './generated/ycombinator.js';
import { GOOGLE_TRENDS_DISPATCH } from './generated/google-trends.js';
import { GLORIA_PREMIUM_REST } from '../clients/gloria-mcp.js';
import { getFunctionPrices } from './function-prices.js';

/** The categories of the public /data-sources page. */
export type DataCategory =
  | 'Social Media'
  | 'Startups and Investors'
  | 'Markets and Crypto'
  | 'Public Records'
  | 'Company Registries'
  | 'Compliance and Verification'
  | 'Jobs and Pay'
  | 'Real Estate'
  | 'Vehicles'
  | 'Reviews and Software'
  | 'Academic Research'
  | 'Code and Developers'
  | 'Companies, People and Contacts'
  | 'Trends, Weather and AI'
  | 'The Open Web';

export interface FunctionBrand {
  /** The end source's display name; never the intermediary. */
  brand: string;
  category: DataCategory;
  /** The call type, in plain words, without the brand. */
  label: string;
}

/** The connector types this map covers. */
export const BRANDED_CONNECTOR_TYPES = [
  'locus',
  'vaaya',
  'tikhub',
  'strale',
  'kadec0',
  'nasdaq',
  'defillama',
  'ycombinator',
  'google_trends',
  'gloria',
] as const;

/** Intermediaries and resellers. None may appear, as a whole word, in any
 *  brand or label. */
export const FORBIDDEN_WORDS = [
  'locus', 'vaaya', 'strale', 'tikhub', 'apify', 'kadec0', 'x402', 'browserbase',
  'gloria', 'firecrawl', 'exa', 'signalbase', 'tomba', 'monid', 'parse',
  'blockrun', 'dataforseo', 'kronossignals', 'kronos',
];

/** Whitespace-separated names, for the long lists below. */
function names(list: string): string[] {
  return list.trim().split(/\s+/);
}

// ── Strale and kadec0: the data functions, hand-picked ────────────────────

const B = {
  academicPapers: { brand: 'Academic Papers', category: 'Academic Research' },
  arxiv: { brand: 'arXiv', category: 'Academic Research' },
  pubmed: { brand: 'PubMed', category: 'Academic Research' },
  hackerNews: { brand: 'Hacker News', category: 'Code and Developers' },
  github: { brand: 'GitHub', category: 'Code and Developers' },
  npm: { brand: 'npm', category: 'Code and Developers' },
  pypi: { brand: 'PyPI', category: 'Code and Developers' },
  dockerHub: { brand: 'Docker Hub', category: 'Code and Developers' },
  secEdgar: { brand: 'SEC EDGAR', category: 'Public Records' },
  gleif: { brand: 'GLEIF', category: 'Company Registries' },
  euTed: { brand: 'EU TED', category: 'Public Records' },
  usgs: { brand: 'USGS', category: 'Trends, Weather and AI' },
  registries: { brand: 'Company Registries', category: 'Company Registries' },
  screening: { brand: 'Sanctions and PEP Screening', category: 'Compliance and Verification' },
  vatIban: { brand: 'VAT and IBAN Checks', category: 'Compliance and Verification' },
  weather: { brand: 'Weather', category: 'Trends, Weather and AI' },
  stockQuotes: { brand: 'Stock Quotes', category: 'Markets and Crypto' },
  defi: { brand: 'DeFi Data', category: 'Markets and Crypto' },
  openWeb: { brand: 'The Open Web', category: 'The Open Web' },
} satisfies Record<string, { brand: string; category: DataCategory }>;
type BrandKey = keyof typeof B;

const STRALE_REGISTRY_FUNCTIONS = names(`
  au_company_data austrian_company_data belgian_company_data brazilian_company_data
  canadian_company_data croatian_company_data cz_company_data estonian_company_data
  finnish_company_data french_company_data german_company_data greek_company_data
  irish_company_data japanese_company_data latvian_company_data lithuanian_company_data
  norwegian_company_data polish_company_data slovak_company_data slovenian_company_data
  spanish_company_data swedish_company_data swiss_company_data uk_company_data us_company_data
  kyb_complete_au kyb_complete_be kyb_complete_ca kyb_complete_ch kyb_complete_de
  kyb_complete_es kyb_complete_fi kyb_complete_fr kyb_complete_no kyb_complete_pl
  kyb_complete_uk kyb_complete_us
  kyb_essentials_au kyb_essentials_be kyb_essentials_ca kyb_essentials_ch kyb_essentials_de
  kyb_essentials_es kyb_essentials_fi kyb_essentials_fr kyb_essentials_no kyb_essentials_pl
  kyb_essentials_se kyb_essentials_uk kyb_essentials_us
  uk_companies_house_officers verify_us_company
`);

const STRALE_PICKS: Record<string, BrandKey> = {
  academic_paper_search: 'academicPapers',
  paper_details: 'academicPapers',
  arxiv_search: 'arxiv',
  pubmed_search: 'pubmed',
  hacker_news_search: 'hackerNews',
  github_repo_analyze: 'github',
  github_repo_compare: 'github',
  github_user_profile: 'github',
  npm_package_info: 'npm',
  pypi_package_info: 'pypi',
  docker_hub_info: 'dockerHub',
  sec_edgar_filings: 'secEdgar',
  lei_lookup: 'gleif',
  ted_procurement: 'euTed',
  usgs_earthquake_search: 'usgs',
  ...Object.fromEntries(STRALE_REGISTRY_FUNCTIONS.map((fn) => [fn, 'registries' as const])),
  sanctions_check: 'screening',
  pep_check: 'screening',
  aml_risk_score: 'screening',
  adverse_media_check: 'screening',
  vat_validate: 'vatIban',
  vat_format_validate: 'vatIban',
  vat_rate_lookup: 'vatIban',
  iban_validate: 'vatIban',
  iban_to_bank: 'vatIban',
  bank_bic_lookup: 'vatIban',
  swift_validate: 'vatIban',
  eori_validate: 'vatIban',
  tax_id_validate: 'vatIban',
  weather_lookup: 'weather',
  stock_quote: 'stockQuotes',
  ticker_lookup: 'stockQuotes',
  protocol_tvl_lookup: 'defi',
  protocol_fees_lookup: 'defi',
};

const KADEC0_PICKS: Record<string, { key: BrandKey; label: string }> = {
  search_web_serp: { key: 'openWeb', label: 'Web search' },
  scrape_url_markdown: { key: 'openWeb', label: 'Page scrape' },
  search_sec_filings: { key: 'secEdgar', label: 'Full-text filings search' },
  get_defi_tvl: { key: 'defi', label: 'Protocol and chain TVL' },
  get_token_price: { key: 'defi', label: 'Token price' },
  search_academic_papers: { key: 'academicPapers', label: 'Search across paper indexes' },
};

/** Priced functions deliberately left out of the map: processing and utility
 *  tools, not data sources, and the whole of browserbase_x402 (a browser, not
 *  a source). A newly priced function must be mapped or named here. */
export const EXCLUDED: Record<string, readonly string[] | 'all'> = {
  browserbase_x402: 'all',
  kadec0: names(`get_market_sentiment get_congress_trades get_domain_info validate_email_address`),
  strale: names(`
    accessibility_audit address_geocode address_parse address_validate age_verify
    agent_trace_analyze ai_act_assess api_docs_generate api_health_check api_mock_response
    backlink_check barcode_lookup base64_encode_url beneficial_ownership_lookup blog_post_outline
    brand_mention_search business_day_check c2pa_inspect changelog_generate charity_lookup_uk
    classify_text code_convert code_review commit_message_generate company_enrich
    company_id_detect company_industry_classify company_name_match company_tech_stack
    competitor_compare competitor_read competitor_snapshot contact_verify container_track
    context_window_optimize contract_extract cookie_scan country_economic_indicators
    country_tax_rates country_trade_data credit_score_band cron_explain crontab_generate
    csv_clean csv_to_json curl_to_code currency_convert customer_risk_screen
    customs_duty_lookup cve_details cve_lookup dangerous_goods_classify
    data_protection_authority_lookup data_quality_check date_parse deduplicate
    dependency_audit diff_json dns_lookup dockerfile_generate docstring_generate
    domain_age_check domain_contact_extract domain_intel domain_reputation domain_trust
    email_audit email_auth_check email_deliverability_check email_draft
    email_reputation_score email_validate email_validate_bulk employment_cost_estimate
    enhanced_due_diligence ens_resolve ens_reverse_lookup env_template_generate error_explain
    eu_ai_act_classify eu_regulation_search eu_trademark_search exchange_rate
    fake_data_generate fear_greed_index financial_year_dates flatten_json flight_status
    food_safety_rating_uk forex_history french_insolvency_check gdpr_audit gdpr_fine_lookup
    gdpr_website_check github_actions_generate gitignore_generate google_search
    header_security_check holiday_calendar hr_candidate_screen hs_code_lookup html_to_pdf
    http_to_curl id_number_validate image_resize image_to_text incoterms_explain
    insolvency_check invoice_extract invoice_process invoice_validate
    invoice_verify_au invoice_verify_be invoice_verify_ca invoice_verify_ch invoice_verify_de
    invoice_verify_es invoice_verify_fi invoice_verify_fr invoice_verify_no invoice_verify_pl
    invoice_verify_se invoice_verify_uk invoice_verify_us
    ip_risk_score isbn_validate iso_country_lookup job_board_search job_posting_analyze
    jsdoc_generate json_repair json_schema_validate json_to_csv json_to_pydantic
    json_to_typescript json_to_zod jwt_decode keyword_rank_check
    kyc_denmark kyc_finland kyc_norway kyc_sweden
    landing_page_roast language_detect lead_email_verify lead_enrich
    license_compatibility_check link_extract llm_cost_calculate llm_output_validate log_parse
    markdown_to_html marketplace_fee_calculate meeting_notes_extract meta_extract mx_lookup
    name_parse nginx_config_generate og_image_check openapi_generate openapi_validate
    package_security_audit page_seo_check paid_api_preflight password_strength
    payment_reference_generate payment_validate pdf_extract phishing_site_check
    phone_normalize phone_type_detect phone_validate pii_redact port_check port_lookup
    postal_code_lookup pr_description_generate price_compare pricing_page_extract
    privacy_policy_analyze product_reviews_extract prompt_compress prompt_optimize
    prospect_brief prospect_profile public_holiday_lookup readme_generate receipt_categorize
    redirect_trace regex_explain regex_generate release_notes_generate resume_parse
    return_policy_extract risk_narrative_generate robots_txt_parse schema_infer
    schema_migration_generate screenshot_url secret_scan sentiment_analyze seo_audit
    sepa_readiness sepa_xml_validate serp_analyze shipping_cost_estimate shipping_track
    sitemap_parse skill_extract skill_gap_analyze social_post_generate social_profile_check
    sql_explain sql_generate sql_optimize ssl_certificate_chain ssl_check
    stablecoin_flow_check startup_domain_check structured_scrape summarize
    swift_message_parse tech_stack_detect terms_of_service_extract test_case_generate
    timezone_lookup timezone_meeting_find tool_call_validate translate
    uk_disqualified_director_check unit_convert uptime_check url_health_check
    url_to_markdown url_to_text us_product_recall_search vasp_non_compliant_check
    vasp_verify vendor_onboard vendor_risk_assess web_extract web_extract_clean
    webhook_test_payload website_carbon_estimate website_health website_security_audit
    whois_lookup work_permit_requirements xml_to_json
  `),
};

// ── Labels ─────────────────────────────────────────────────────────────────

/** Words that keep a fixed spelling in a label. */
const WORD_SPELLINGS: Record<string, string> = {
  ai: 'AI', api: 'API', dex: 'DEX', etf: 'ETF', ev: 'EV', h1b: 'H-1B', id: 'ID', ids: 'IDs',
  ipo: 'IPO', llm: 'LLM', obd: 'OBD', pws: 'PWS', sec: 'SEC', tvl: 'TVL', uid: 'UID',
  url: 'URL', vin: 'VIN', '13d': '13D', '13g': '13G', marketrank: 'MarketRank',
  web3: 'Web3', pnl: 'PnL', defi: 'DeFi', v1: 'V1', v2: 'V2', v3: 'V3', v5: 'V5',
};

/** Title-case words that are proper nouns and keep their capital. */
const PROPER_WORDS = new Set(names(`
  Australian Austrian Belgian Brazilian Canadian Croatian Czech Estonian Finnish French
  German Greek Irish Japanese Latvian Lithuanian Norwegian Polish Slovak Slovenian Spanish
  Swedish Swiss Australia Belgium Canada Switzerland Germany Spain Finland France Norway
  Poland Sweden United Kingdom States LinkedIn
`));

/** Sentence case: the first letter up, every ordinary Title-case word down;
 *  acronyms, mixed-case names and proper nouns keep their spelling. */
function sentenceCase(text: string): string {
  const words = text.split(' ').map((w) => {
    const spelled = WORD_SPELLINGS[w.toLowerCase()];
    if (spelled) return spelled;
    if (PROPER_WORDS.has(w)) return w;
    return /^[A-Z][a-z'-]*[:,]?$/.test(w) ? w.toLowerCase() : w;
  });
  const out = words.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** A function name, humanised: `search_homes_for_sale` → "Search homes for
 *  sale", a leading get/fetch dropped, a trailing Markdown marker dropped. */
function humanise(name: string): string {
  const words = name.split('_').filter(Boolean);
  if (words.length > 1 && (words[0] === 'get' || words[0] === 'fetch')) words.shift();
  if (words.length > 1 && words[words.length - 1] === 'md') words.pop();
  return sentenceCase(words.map((w) => WORD_SPELLINGS[w] ?? w).join(' '));
}

/** The label from a description: its leading title, without the reseller's
 *  "(x402) (about $… per call)" tail, a leading brand, or an em dash. */
function titleLabel(description: string, brand: string): string {
  let title = description.replace(/\s*\(x402[^)]*\).*$/i, '').trim();
  title = title.replace(/\s+—\s+/g, ': ');
  if (title.toLowerCase().startsWith(`${brand.toLowerCase()} `)) title = title.slice(brand.length + 1);
  return sentenceCase(title);
}

/** Labels too awkward to derive, by connector type then function. */
const LABEL_OVERRIDES: Record<string, Record<string, string>> = {
  locus: {
    // Curated resale, labelled by hand.
    crypto_fear_greed_index: 'Fear and greed index',
    us_stock_symbols: 'US stock symbols',
    currency_daily_exchange_rate: 'Daily exchange rate',
    commodity_daily_price: 'Daily commodity price',
    people_search: 'People search',
    people_enrich: 'Person enrichment',
    company_search: 'Company search',
    company_enrich: 'Company enrichment',
    company_job_postings: 'Company job postings',
    email_find: 'Email finder',
    email_verify: 'Email verification',
    domain_emails: 'Emails at a domain',
    person_profile_enrich: 'Person profile enrichment',
    company_profile_enrich: 'Company profile enrichment',
    linkedin_contact_details: 'Contact details from a LinkedIn profile',
    startup_search: 'Company search',
    startup_profile: 'Company profile',
    startup_funding_rounds: 'Funding rounds',
    startup_people: 'Company people',
    investor_search: 'Investor search',
    stock_key_statistics: 'Key statistics',
    fund_top_holdings: 'Fund top holdings',
    ticker_lookup: 'Ticker lookup',
    web_page_scrape: 'Page scrape',
    web_search_results: 'Web search',
    web_site_map: 'Site map',
    web_page_text: 'Page text',
    web_semantic_search: 'Semantic web search',
    // Public-data endpoints whose names read badly.
    vehicle_history_get_value: 'Listing value rating',
    home_listings_get: 'Home value estimate',
    weather_history_get_pws_hourly_history: 'Weather station hourly history',
    weather_history_get_historical_airport: 'Historical airport weather',
    weather_history_get_airport_temperature_updates_batch: 'Airport temperature updates in batch',
    stock_fundamentals_get_stock_financials_income: 'Income statement',
    stock_fundamentals_get_market_movers_premarket: 'Premarket movers',
    ai_model_benchmarks_get_speech_image_video_models: 'Speech, image and video models',
    company_database_get_pricing: 'Pricing plans',
    insider_trading_search: 'Search insider filings',
    insider_trading_get_insider_buy_sell_ratios: 'Insider buy and sell ratios',
    stock_market_get_quote: 'Stock quote',
  },
  vaaya: {
    linkedin_email: 'Email from a LinkedIn profile',
    person_from_email: 'Person from an email address',
    funding_rounds: 'Funding rounds',
    acquisitions: 'Acquisitions',
    hiring_signals: 'Hiring signals',
    executive_moves: 'Executive moves',
    sec_filings_search: 'Full-text filings search',
    sec_company_filings: 'Company filings',
    patent_search: 'Patent search',
    court_opinions_search: 'Court opinions search',
  },
  strale: {
    arxiv_search: 'Paper search',
    pubmed_search: 'Literature search',
    hacker_news_search: 'Story search',
    github_repo_analyze: 'Repository analysis',
    github_repo_compare: 'Repository comparison',
    docker_hub_info: 'Image info',
    german_company_data: 'German company data',
    uk_companies_house_officers: 'UK Companies House officers',
    verify_us_company: 'US company verification',
    tax_id_validate: 'Tax ID validation',
    ted_procurement: 'Procurement tender search',
    usgs_earthquake_search: 'Earthquake search',
    sec_edgar_filings: 'Company filings',
    weather_lookup: 'Weather lookup',
  },
  tikhub: {
    bilibili_app_fetch_search_all: 'Search all',
    bilibili_app_fetch_search_by_type: 'Search by type',
    bilibili_web_fetch_comment_reply: 'Comment replies',
    bilibili_web_fetch_video_comments: 'Video comments',
    douyin_app_v3_open_douyin_app_to_user_profile: 'App link to a user profile',
    douyin_app_v3_open_douyin_app_to_video_detail: 'App link to a video',
    tiktok_app_v3_open_tiktok_app_to_user_profile: 'App link to a user profile',
    tiktok_app_v3_open_tiktok_app_to_video_detail: 'App link to a video',
    douyin_douplus_search_user: 'Search users',
    douyin_index_fetch_daren_great_user_fans_info: 'Creator follower analysis',
    douyin_web_handler_user_profile_v4: 'User profile',
    instagram_v1_fetch_search: 'Search places',
    lemon8_app_fetch_search: 'Search',
    tiktok_app_v3_fetch_webcast_user_info: 'Live user profile',
    twitter_web_fetch_search_timeline: 'Search posts',
    twitter_web_fetch_user_post_tweet: 'User posts',
    twitter_web_fetch_latest_post_comments: 'Latest post comments',
    twitter_web_fetch_post_comments: 'Post comments',
    twitter_web_fetch_user_profiles_by_rest_ids: 'Profiles by user IDs',
    wechat_mp_v2_fetch_comment_replies: 'Official account comment replies',
    wechat_search_v2_fetch_search: 'Universal search',
    wechat_search_v2_fetch_search_videos: 'Channels video search',
    wechat_channels_v2_fetch_search_channel_videos: 'Search videos within a channel',
    wechat_channels_v2_fetch_user_profile: 'Channels user profile and stats',
    wechat_channels_v2_fetch_user_videos: 'Channels user videos',
    wechat_channels_v2_fetch_video_comments: 'Channels video comments',
    wechat_channels_v2_fetch_video_detail: 'Channels video detail',
    youtube_web_v2_get_general_search: 'General search',
    youtube_web_v2_get_video_comment_replies: 'Video comment replies',
    zhihu_web_fetch_comment_v5: 'Comments',
    tiktok_app_v3_fetch_general_search_result: 'Comprehensive search results',
    tiktok_app_v3_fetch_user_follower_list: 'User followers',
    tiktok_app_v3_fetch_user_following_list: 'User following',
    lemon8_app_fetch_user_follower_list: 'User followers',
    weibo_web_v2_fetch_post_comments: 'Post comments',
    weibo_web_v2_fetch_user_video_list: 'All user videos',
  },
  defillama: {
    defi_protocols_search: 'Protocol search',
    token_prices_current: 'Current token prices',
  },
  google_trends: {
    get_keyword_related_queries: 'Related queries',
    get_keyword_related_topics: 'Related topics',
  },
  gloria: {
    get_ticker_summary: 'Ticker news summary',
  },
};

// ── TikHub: the platform is the brand ──────────────────────────────────────

const TIKHUB_PLATFORMS: Record<string, string> = {
  tiktok: 'TikTok', instagram: 'Instagram', douyin: 'Douyin', weibo: 'Weibo',
  bilibili: 'Bilibili', twitter: 'X', x: 'X', youtube: 'YouTube', wechat: 'WeChat',
  reddit: 'Reddit', threads: 'Threads', lemon8: 'Lemon8', kuaishou: 'Kuaishou',
  zhihu: 'Zhihu', xiaohongshu: 'Xiaohongshu', linkedin: 'LinkedIn', telegram: 'Telegram',
};

/** A TikHub description, cleaned into a label: the vendor writes "Get
 *  information of specified user", "Fetch Reddit APP Post Comments". */
function tikhubLabel(description: string, platform: string): string {
  let s = description
    .replace(/\s*\([^)]*\)/g, '') // "(by id or link)", "(simplified data - faster)"
    .replace(/V(\d)\(.*$/, 'V$1')
    .replace(new RegExp(`\\b${platform}\\b`, 'gi'), '')
    .replace(/\b(APP|DOU\+)\b/g, '')
    .replace(/^\s*(Get|Fetch)\s+/i, '')
    .replace(/\bhomepage video data\b/i, 'homepage videos')
    .replace(/\buser data\b/i, 'user profile')
    .replace(/\buser's\b/i, 'user')
    .replace(/\binformation of specified user\b/i, 'user profile')
    .replace(/\binformation of specified post\b/i, 'post detail')
    .replace(/\buser information\b/i, 'user profile')
    .replace(/\buser detail information\b/i, 'user profile detail')
    .replace(/\buser information by\b/i, 'user profile by')
    .replace(/\b(of )?(the )?specified\b/gi, (m) => (m.toLowerCase().startsWith('of') ? 'of' : ''))
    .replace(/\bsingle\s+/gi, '')
    .replace(/\s+by\s+\S*_\S*/gi, '') // "by sec_user_id": a parameter name, not a call type
    .replace(/\s+data\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "comments list of post" / "follower list of user" read better as "post comments".
  const of = /^(.+?) (?:list )?of (user|video|post|keywords)$/i.exec(s);
  if (of) s = `${of[2]} ${of[1].replace(/ list$/i, '')}`;
  s = s.replace(/\bcomments list\b/i, 'comments').replace(/\bvideo comment$/i, 'video comments');
  // "Get single post data" leaves one word.
  if (/^(post|video)( V\d)?$/i.test(s)) s = s.replace(/^(post|video)/i, '$1 detail');
  return sentenceCase(s);
}

// ── Assembly ───────────────────────────────────────────────────────────────

type BrandMap = Record<string, FunctionBrand>;

/** Locus's curated resale, branded by the dispatch slug it calls. */
const LOCUS_SLUG_BRANDS: Array<{ test: (slug: string) => boolean; brand: string; category: DataCategory }> = [
  { test: (s) => s.startsWith('apollo/'), brand: 'Apollo', category: 'Companies, People and Contacts' },
  { test: (s) => s.startsWith('hunter/'), brand: 'Hunter', category: 'Companies, People and Contacts' },
  { test: (s) => s.startsWith('mpp-orth-peopledatalabs/'), brand: 'People Data Labs', category: 'Companies, People and Contacts' },
  { test: (s) => s.startsWith('mpp-orth-contactout/'), brand: 'ContactOut', category: 'Companies, People and Contacts' },
  { test: (s) => s.startsWith('parse-crunchbase-'), brand: 'Crunchbase', category: 'Startups and Investors' },
  { test: (s) => s.startsWith('parse-finance-yahoo-'), brand: 'Yahoo Finance', category: 'Markets and Crypto' },
  { test: (s) => s.startsWith('firecrawl/'), brand: 'The Open Web', category: 'The Open Web' },
  { test: (s) => s.startsWith('x402-api-exa-'), brand: 'The Open Web', category: 'The Open Web' },
  // The six providers below. CoinGecko and Nansen are the data's
  // own publishers. DataForSEO resells Google's results and BlockRun resells
  // Kalshi's and Polymarket's markets, so those are named for the source; the
  // stock-symbol list and Kronos's two market signals have no publisher a
  // person would know, so they take the generic sources already used above.
  { test: (s) => s.startsWith('coingecko/'), brand: 'CoinGecko', category: 'Markets and Crypto' },
  { test: (s) => s.startsWith('dataforseo/'), brand: 'Google Search', category: 'Trends, Weather and AI' },
  { test: (s) => s.startsWith('x402-api-nansen-ai-'), brand: 'Nansen', category: 'Markets and Crypto' },
  { test: (s) => s.startsWith('x402-blockrun-ai-api-v1-pm-kalshi-'), brand: 'Kalshi', category: 'Markets and Crypto' },
  { test: (s) => s.startsWith('x402-blockrun-ai-api-v1-pm-polymarket-'), brand: 'Polymarket', category: 'Markets and Crypto' },
  { test: (s) => s.startsWith('x402-blockrun-public-usstock-'), brand: 'Stock Quotes', category: 'Markets and Crypto' },
  { test: (s) => s.startsWith('x402-kronossignals-com-'), brand: 'Crypto Signals', category: 'Markets and Crypto' },
  // Exchange rates and commodity prices. Chainlink publishes
  // these feeds, so it is the source a person is paying for and the reseller in
  // front of it is not. The reseller's CATALOGUE text credits Pyth; every live
  // answer says `source: "chainlink"`, and the live answer is the one that
  // served the row.
  { test: (s) => s.startsWith('x402-blockrun-fx-'), brand: 'Chainlink', category: 'Markets and Crypto' },
  { test: (s) => s.startsWith('x402-blockrun-commodity-'), brand: 'Chainlink', category: 'Markets and Crypto' },
];

// A SLUG THAT MATCHES NO RULE ABOVE IS SKIPPED, not defaulted — `locus()` does
// `if (!rule) continue` — so the function is charged for and never appears on
// the Data Sources page. The coverage test is what catches that: every priced
// function of a covered type is mapped here or named in EXCLUDED, and a
// function newly added to the dispatch fails the suite until someone decides
// what its source is. Two things about the prefixes are worth knowing before
// the rest of the reseller's catalogue is onboarded, because neither is
// guessable from the rules as written:
//
//  - its prediction-market slugs come in TWO shapes. The four served here are
//    `x402-blockrun-ai-api-v1-pm-…`; the ~46 others it offers (Polymarket
//    depth, Kalshi, Limitless, Opinion, Predict.Fun, Binance) are
//    `x402-blockrun-pm-…` and match no rule above.
//  - `dataforseo/*` maps wholesale to Google Search, which is true of the two
//    endpoints served here (organic results and Google Ads keyword volume) and
//    FALSE of most of the other 87 the reseller now offers: backlinks and spam
//    scores are the vendor's own crawl index, `keywords_data/bing/*` is Bing,
//    `domain_analytics/whois` is WHOIS, and the Amazon and Apple endpoints are
//    those stores. Onboarding them means splitting this rule by path family,
//    not widening it.

/** Each resold public-data provider's display name, by Locus provider id. */
export const LOCUS_PARSE_PROVIDER_BRANDS: Record<string, string> = {
  'parse-polymarket-com-api-356a9c18': 'Polymarket',
  'parse-app-hyperliquid-xyz-api-0ef2734c': 'Hyperliquid',
  'parse-carfax-com-api-1c2d366b': 'Carfax',
  'parse-cars-com-api-ccacb270': 'Cars.com',
  'parse-kbb-com-api-0284bc02': 'Kelley Blue Book',
  'parse-edmunds-com-api-6d4b8554': 'Edmunds',
  'parse-bid-cars-api-5b8ead15': 'bid.cars',
  'parse-gasprices-aaa-com-api-a0d5d03f': 'AAA',
  'parse-zillow-com-api-082cc2d5': 'Zillow',
  'parse-homes-com-api-e536d79b': 'Homes.com',
  'parse-loopnet-com-api-9d3a7974': 'LoopNet',
  'parse-indeed-com-api-ef57dcec': 'Indeed',
  'parse-wellfound-com-api-d395faef': 'Wellfound',
  'parse-levels-fyi-api-543e5df9': 'Levels.fyi',
  'parse-builtin-com-api-86aeeb18': 'Built In',
  'parse-idealist-org-api-f95f3567': 'Idealist',
  'parse-web3-career-api-e485a330': 'web3.career',
  'parse-g2-com-api-02e11b38': 'G2',
  'parse-capterra-com-api-786d1eda': 'Capterra',
  'parse-getapp-com-api-96bffcf5': 'GetApp',
  'parse-trustpilot-com-api-430e0263': 'Trustpilot',
  'parse-marketbeat-com-api-7efa2b5b': 'MarketBeat',
  'parse-secform4-com-api-a56dfc20': 'SEC Form 4',
  'parse-stockanalysis-com-api-c9e8ac45': 'StockAnalysis',
  'parse-finviz-com-api-09c62661': 'Finviz',
  'parse-yahoofinance-com-api-417d966a': 'Yahoo Finance',
  'parse-accuweather-com-api-d84777ff': 'AccuWeather',
  'parse-iqair-com-api-c60726f6': 'IQAir',
  'parse-wunderground-com-api-31a45835': 'Weather Underground',
  'parse-thecompaniesapi-com-api-54ff4b40': 'TheCompaniesAPI',
  'parse-artificialanalysis-ai-api-38112545': 'Artificial Analysis',
  'parse-lmarena-ai-api-f4504720': 'LMArena',
};

/** The /data-sources category of each allowlist bucket. */
const LOCUS_PARSE_BUCKET_CATEGORIES: Record<string, DataCategory> = {
  automotive: 'Vehicles',
  real_estate: 'Real Estate',
  jobs: 'Jobs and Pay',
  reviews: 'Reviews and Software',
  finance: 'Markets and Crypto',
  crypto: 'Markets and Crypto',
  geo_reference: 'Trends, Weather and AI',
  lead_generation: 'Companies, People and Contacts',
  ai_models: 'Trends, Weather and AI',
};

function label(connectorType: string, fn: string, derived: () => string): string {
  return LABEL_OVERRIDES[connectorType]?.[fn] ?? derived();
}

function locus(): BrandMap {
  const out: BrandMap = {};
  for (const [fn, entry] of Object.entries(LOCUS_DISPATCH)) {
    const rule = LOCUS_SLUG_BRANDS.find((r) => r.test(entry.slug));
    if (!rule) continue;
    out[fn] = { brand: rule.brand, category: rule.category, label: label('locus', fn, () => humanise(fn)) };
  }
  const providers = new Map(LOCUS_PARSE_ALLOWLIST.map((p) => [p.provider, p]));
  for (const [fn, entry] of Object.entries(LOCUS_PARSE_DISPATCH)) {
    const provider = providers.get(entry.slug.split('/')[0]);
    const brand = provider && LOCUS_PARSE_PROVIDER_BRANDS[provider.provider];
    const category = provider && LOCUS_PARSE_BUCKET_CATEGORIES[provider.bucket];
    if (!provider || !brand || !category) continue;
    const rest = fn.startsWith(`${provider.prefix}_`) ? fn.slice(provider.prefix.length + 1) : fn;
    out[fn] = { brand, category, label: label('locus', fn, () => humanise(rest)) };
  }
  return out;
}

const VAAYA_ACTION_BRANDS: Record<string, { brand: string; category: DataCategory }> = {
  // Tomba and Signalbase are resellers themselves; the call is named for
  // what it finds, never for them.
  tomba: { brand: 'Email Finder', category: 'Companies, People and Contacts' },
  signalbase: { brand: 'Company Signals', category: 'Startups and Investors' },
  edgar: { brand: 'SEC EDGAR', category: 'Public Records' },
  uspto: { brand: 'USPTO', category: 'Public Records' },
  courtlistener: { brand: 'CourtListener', category: 'Public Records' },
};

/** Two databases reached over the aggregator, named the way the public
 *  /data-sources page names them. They are SOURCES, not the delivery layer:
 *  each returns its own identifiers (a private-company uuid and rank, a
 *  funding permalink), which is what tells a database apart from a reseller
 *  and why neither belongs in FORBIDDEN_WORDS.
 *
 *  Keyed by the WHOLE action, read before the prefix map above, so one call
 *  can be branded for its own upstream while its neighbours are not. The
 *  CATEGORY, though, is a property of the brand and not of the call: a brand
 *  files under exactly one, which is why every call on the company database
 *  sits with the other company databases rather than being scattered across
 *  the four categories its subjects would suggest.
 *
 *  Employee reviews are the one call that names its own upstream: every
 *  review carries provider 'glassdoor', the totals are counted by provider,
 *  and each review links to glassdoor.com. So it is branded Glassdoor rather
 *  than by the database that relays it -- the same rule, applied one level
 *  further down, and the only one of the twenty-one where the evidence
 *  supports going that far. It files under Jobs and Pay, not under reviews:
 *  what it returns is employment data (pay and benefits ratings, job title,
 *  employment status, years served), which belongs beside the pay and roles
 *  sources rather than beside the software directories. */
const VAAYA_FULL_ACTION_BRANDS: Record<string, { brand: string; category: DataCategory }> = {
  'akta/company-search': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'akta/industry-search': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'akta/company-enrich': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'akta/news': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'akta/employee-reviews': { brand: 'Glassdoor', category: 'Jobs and Pay' },
  'akta/product-reviews': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'akta/headcount-trends': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'akta/website-traffic': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'akta/job-posts': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'akta/social-posts': { brand: 'Akta', category: 'Companies, People and Contacts' },
  'fundable/deals': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/company': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/company-deals': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/deal-investors': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/investor-deals': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/person-deals': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/company-search': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/investor-search': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/person-search': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/industry-search': { brand: 'Fundable', category: 'Startups and Investors' },
  'fundable/location-search': { brand: 'Fundable', category: 'Startups and Investors' },
};

/** One rung serves several prediction venues through a single action, so the
 *  end source is in the path rather than the action. Branded by the venue the
 *  data is actually from -- the same rule the rest of this file follows, and
 *  the reason the rung's own name appears nowhere. */
const VAAYA_ENDPOINT_BRANDS: Array<{ test: (ep: string) => boolean; brand: string; category: DataCategory }> = [
  { test: (e) => e.startsWith('/api/v1/pm/kalshi/'), brand: 'Kalshi', category: 'Markets and Crypto' },
  { test: (e) => e.startsWith('/api/v1/pm/polymarket/'), brand: 'Polymarket', category: 'Markets and Crypto' },
  { test: (e) => e.startsWith('/api/v1/pm/limitless/'), brand: 'Limitless', category: 'Markets and Crypto' },
  { test: (e) => e.startsWith('/api/v1/pm/opinion/'), brand: 'Opinion', category: 'Markets and Crypto' },
  { test: (e) => e.startsWith('/api/v1/pm/predictfun/'), brand: 'PredictFun', category: 'Markets and Crypto' },
  { test: (e) => e.startsWith('/api/v1/pm/binance/'), brand: 'Binance', category: 'Markets and Crypto' },
  // The one read that is not a venue's own: it searches every venue at once
  // and says which one each result is on (polymarket, kalshi, predict,
  // limitless and opinion answered a live call). No single brand is the
  // source, so it is named for what it searches -- the same choice the
  // action map above makes for the calls whose supplier resells others.
  { test: (e) => e === '/api/v1/pm/markets/search', brand: 'Prediction Markets', category: 'Markets and Crypto' },
];

function vaaya(): BrandMap {
  const out: BrandMap = {};
  for (const [fn, entry] of Object.entries(VAAYA_DISPATCH)) {
    const ep = typeof entry.fixed?.endpoint === 'string' ? entry.fixed.endpoint : null;
    const byEndpoint = ep ? VAAYA_ENDPOINT_BRANDS.find((r) => r.test(ep)) : undefined;
    const b = byEndpoint
      ? { brand: byEndpoint.brand, category: byEndpoint.category }
      : VAAYA_FULL_ACTION_BRANDS[entry.action] ?? VAAYA_ACTION_BRANDS[entry.action.split('/')[0]];
    if (b) out[fn] = { ...b, label: label('vaaya', fn, () => humanise(fn)) };
  }
  return out;
}

function tikhub(): BrandMap {
  const out: BrandMap = {};
  for (const f of TIKHUB_FUNCTIONS) {
    const platform = f.name.split('_')[0];
    const brand = TIKHUB_PLATFORMS[platform];
    if (!brand) continue;
    out[f.name] = {
      brand,
      category: 'Social Media',
      label: label('tikhub', f.name, () => tikhubLabel(f.description, platform === 'twitter' ? 'twitter' : brand)),
    };
  }
  return out;
}

function strale(): BrandMap {
  const out: BrandMap = {};
  for (const f of STRALE_FUNCTIONS) {
    const key = STRALE_PICKS[f.name];
    if (!key) continue;
    const b = B[key];
    out[f.name] = { ...b, label: label('strale', f.name, () => titleLabel(f.description, b.brand)) };
  }
  return out;
}

function kadec0(): BrandMap {
  const out: BrandMap = {};
  for (const fn of Object.keys(KADEC0_DISPATCH)) {
    const pick = KADEC0_PICKS[fn];
    if (pick) out[fn] = { ...B[pick.key], label: pick.label };
  }
  return out;
}

/** A whole connector type from one source. */
function single(connectorType: string, fns: string[], brand: string, category: DataCategory, strip = ''): BrandMap {
  return Object.fromEntries(
    fns.map((fn) => {
      const rest = strip && fn.startsWith(strip) ? fn.slice(strip.length) : fn;
      return [fn, { brand, category, label: label(connectorType, fn, () => humanise(rest)) }];
    }),
  );
}

/** A supplier's API version is not something a customer chooses, so it never
 *  reaches a label. Calls of one brand that then read the same are one call
 *  type to the customer; platform-backend lists them once, at the higher rate. */
function withoutVersions(map: BrandMap): BrandMap {
  return Object.fromEntries(
    Object.entries(map).map(([fn, b]) => [fn, { ...b, label: b.label.replace(/\s+V\d+\b/g, '') }]),
  );
}

/** Only what is priced: a function the platform does not pay for has no
 *  rate to show. */
function priced(connectorType: string, map: BrandMap): BrandMap {
  const prices = getFunctionPrices(connectorType) ?? {};
  return Object.fromEntries(Object.entries(map).filter(([fn]) => fn in prices));
}

function build(): Record<string, BrandMap> {
  const maps: Record<string, BrandMap> = {
    locus: locus(),
    vaaya: vaaya(),
    tikhub: tikhub(),
    strale: strale(),
    kadec0: kadec0(),
    nasdaq: single('nasdaq', NASDAQ_FUNCTIONS.map((f) => f.name), 'Nasdaq', 'Markets and Crypto', 'get_'),
    defillama: single('defillama', DEFILLAMA_FUNCTIONS.map((f) => f.name), 'DefiLlama', 'Markets and Crypto', 'defi_'),
    ycombinator: single('ycombinator', YCOMBINATOR_FUNCTIONS.map((f) => f.name), 'Y Combinator', 'Startups and Investors', 'yc_'),
    google_trends: single('google_trends', Object.keys(GOOGLE_TRENDS_DISPATCH), 'Google Trends', 'Trends, Weather and AI', 'get_'),
    gloria: single('gloria', Object.keys(GLORIA_PREMIUM_REST), 'Crypto News', 'Markets and Crypto', 'get_'),
  };
  return Object.fromEntries(Object.entries(maps).map(([type, map]) => [type, withoutVersions(priced(type, map))]));
}

let cached: Record<string, BrandMap> | undefined;

/** Brand, category and label of every mapped platform-funded function, by
 *  connector type then function name. */
export function getFunctionBrands(): Record<string, Record<string, FunctionBrand>> {
  cached ??= build();
  return cached;
}

/** One connector type's map, or undefined when it has no entries. */
export function getFunctionBrandsFor(connectorType: string): Record<string, FunctionBrand> | undefined {
  const map = getFunctionBrands()[connectorType];
  return map && Object.keys(map).length > 0 ? map : undefined;
}
