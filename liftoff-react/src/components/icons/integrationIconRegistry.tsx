// The id -> icon registry and its lookup. Separate from the icon components
// themselves so that file exports components only and stays fast-refreshable.
import type { ReactNode } from 'react'
import * as Icons from './IntegrationIcons'
// Real vendor marks for the newly BYO-connectable Composio-managed vendors,
// sourced from the Composio logo CDN (logos.composio.dev/api/<toolkit slug>:
// peopledatalabs, hunter, saperly) and vendored as assets so they bundle like
// every other icon — width/height stripped so they scale to the container.
import PdlLogo from '../../assets/icons/pdl.svg?react'
import HunterioLogo from '../../assets/icons/hunterio.svg?react'
import SaperlyLogo from '../../assets/icons/saperly.svg?react'
// Marketing connectors, same source and convention. The five
// Composio-backed types use their toolkit slug on the CDN (plausible ->
// plausible_analytics); the nine vendor-hosted ones below have a Composio
// toolkit too, so the CDN carries a real mark even though we do not route
// through Composio. Ten types returned the CDN's placeholder: demandbase
// already has its hand-authored DemandbaseIcon below; four publish an SVG mark
// on their own site (SparkToro and Livestorm their favicon.svg, Coupler its
// light-mode favicon, Keywords Everywhere its pinned-tab mark), vendored the
// same way. Crossbeam, Paddle, PartnerStack and Snov.io are the vendors' own
// logo SVGs cropped to the mark (the wordmark dropped, the viewBox fitted to
// the symbol); Tolt is its app icon as the vendor supplied it, with the
// no-op clip path dropped so its id cannot collide with another inline mark.
import GoogleAnalyticsLogo from '../../assets/icons/google_analytics.svg?react'
import GoogleSearchConsoleLogo from '../../assets/icons/google_search_console.svg?react'
import RedditAdsLogo from '../../assets/icons/reddit_ads.svg?react'
import PlausibleLogo from '../../assets/icons/plausible.svg?react'
import DataForSeoLogo from '../../assets/icons/dataforseo.svg?react'
import KlaviyoLogo from '../../assets/icons/klaviyo.svg?react'
import KitLogo from '../../assets/icons/kit.svg?react'
import OmnisendLogo from '../../assets/icons/omnisend.svg?react'
import AmplitudeLogo from '../../assets/icons/amplitude.svg?react'
import PendoLogo from '../../assets/icons/pendo.svg?react'
import WebflowLogo from '../../assets/icons/webflow.svg?react'
import TypefullyLogo from '../../assets/icons/typefully.svg?react'
import CrustdataLogo from '../../assets/icons/crustdata.svg?react'
import TapfiliateLogo from '../../assets/icons/tapfiliate.svg?react'
import SparktoroLogo from '../../assets/icons/sparktoro.svg?react'
import LivestormLogo from '../../assets/icons/livestorm.svg?react'
import CouplerLogo from '../../assets/icons/coupler.svg?react'
import KeywordsEverywhereLogo from '../../assets/icons/keywords_everywhere.svg?react'
import CrossbeamLogo from '../../assets/icons/crossbeam.svg?react'
import PaddleLogo from '../../assets/icons/paddle.svg?react'
import PartnerStackLogo from '../../assets/icons/partnerstack.svg?react'
import SnovLogo from '../../assets/icons/snov.svg?react'
import ToltLogo from '../../assets/icons/tolt.svg?react'

export const INTEGRATION_ICONS: Record<string, ReactNode> = {
  custom_mcp_server: <Icons.McpServerIcon />,
  custom_api_connector: <Icons.CustomApiIcon />,
  pdl: <PdlLogo />,
  hunterio: <HunterioLogo />,
  saperly: <SaperlyLogo />,
  google_analytics: <GoogleAnalyticsLogo />,
  google_search_console: <GoogleSearchConsoleLogo />,
  reddit_ads: <RedditAdsLogo />,
  plausible: <PlausibleLogo />,
  dataforseo: <DataForSeoLogo />,
  klaviyo: <KlaviyoLogo />,
  kit: <KitLogo />,
  omnisend: <OmnisendLogo />,
  amplitude: <AmplitudeLogo />,
  pendo: <PendoLogo />,
  webflow: <WebflowLogo />,
  typefully: <TypefullyLogo />,
  crustdata: <CrustdataLogo />,
  tapfiliate: <TapfiliateLogo />,
  sparktoro: <SparktoroLogo />,
  livestorm: <LivestormLogo />,
  coupler: <CouplerLogo />,
  keywords_everywhere: <KeywordsEverywhereLogo />,
  crossbeam: <CrossbeamLogo />,
  paddle: <PaddleLogo />,
  partnerstack: <PartnerStackLogo />,
  snov: <SnovLogo />,
  tolt: <ToltLogo />,
  salesforce: <Icons.SalesforceIcon />,
  google_mail: <Icons.GmailIcon />,
  google_calendar: <Icons.GoogleCalendarIcon />,
  google_drive: <Icons.GoogleDriveIcon />,
  google_sheets: <Icons.GoogleSheetsIcon />,
  google_docs: <Icons.GoogleDocsIcon />,
  google_ads: <Icons.GoogleAdsIcon />,
  google_slides: <Icons.GoogleSlidesIcon />,
  google_contacts: <Icons.GoogleContactsIcon />,
  google_tasks: <Icons.GoogleTasksIcon />,
  twilio: <Icons.TwilioIcon />,
  website_forms: <Icons.WebsiteFormsIcon />,
  zendesk: <Icons.ZendeskIcon />,
  intercom: <Icons.IntercomIcon />,
  hubspot: <Icons.HubSpotIcon />,
  slack: <Icons.SlackIcon />,
  linkedin: <Icons.LinkedInIcon />,
  notion: <Icons.NotionIcon />,
  stripe: <Icons.StripeIcon />,
  snowflake: <Icons.SnowflakeIcon />,
  github: <Icons.GitHubIcon />,
  gitlab: <Icons.GitLabIcon />,
  jira: <Icons.JiraIcon />,
  confluence: <Icons.ConfluenceIcon />,
  linear: <Icons.LinearIcon />,
  bigquery: <Icons.BigQueryIcon />,
  databricks: <Icons.DatabricksIcon />,
  supabase: <Icons.SupabaseIcon />,
  firestore: <Icons.FirestoreIcon />,
  mongodb: <Icons.MongoDBIcon />,
  sentry: <Icons.SentryIcon />,
  datadog: <Icons.DatadogIcon />,
  reddit: <Icons.RedditIcon />,
  onedrive: <Icons.OneDriveIcon />,
  dropbox: <Icons.DropboxIcon />,
  box: <Icons.BoxIcon />,
  microsoft_excel: <Icons.MicrosoftExcelIcon />,
  microsoft_outlook_mail: <Icons.OutlookMailIcon />,
  microsoft_outlook_calendar: <Icons.OutlookCalendarIcon />,
  microsoft_teams: <Icons.MicrosoftTeamsIcon />,
  microsoft_todo: <Icons.MicrosoftToDoIcon />,
  outlook_contacts: <Icons.OutlookContactsIcon />,
  microsoft_onenote: <Icons.OneNoteIcon />,
  microsoft_sharepoint: <Icons.SharePointIcon />,
  microsoft_planner: <Icons.MicrosoftPlannerIcon />,
  zoom: <Icons.ZoomIcon />,
  meta_ads: <Icons.MetaAdsIcon />,
  mailchimp: <Icons.MailchimpIcon />,
  sendgrid: <Icons.SendGridIcon />,
  cal_com: <Icons.CalComIcon />,
  bamboohr: <Icons.BambooHRIcon />,
  trello: <Icons.TrelloIcon />,
  woocommerce: <Icons.WooCommerceIcon />,
  xero: <Icons.XeroIcon />,
  quickbooks: <Icons.QuickBooksIcon />,
  asana: <Icons.AsanaIcon />,
  pipedrive: <Icons.PipedriveIcon />,
  calendly: <Icons.CalendlyIcon />,
  granola: <Icons.GranolaIcon />,
  docusign: <Icons.DocuSignIcon />,
  square: <Icons.SquareIcon />,
  paypal: <Icons.PayPalIcon />,
  gusto: <Icons.GustoIcon />,
  warp: <Icons.WarpIcon />,
  plaid: <Icons.PlaidIcon />,
  rippling: <Icons.RipplingIcon />,
  gong: <Icons.GongIcon />,
  microsoft_dynamics: <Icons.MicrosoftDynamicsIcon />,
  attio: <Icons.AttioIcon />,
  clay: <Icons.ClayIcon />,
  mesh: <Icons.MeshIcon />,
  outreach: <Icons.OutreachIcon />,
  zoominfo: <Icons.ZoomInfoIcon />,
  common_room: <Icons.CommonRoomIcon />,
  similarweb: <Icons.SimilarwebIcon />,
  ahrefs: <Icons.AhrefsIcon />,
  supermetrics: <Icons.SupermetricsIcon />,
  demandbase: <Icons.DemandbaseIcon />,
  apollo: <Icons.ApolloIcon />,
  marketo: <Icons.MarketoIcon />,
  instantly: <Icons.InstantlyIcon />,
  smartlead: <Icons.SmartleadIcon />,
  salesloft: <Icons.SalesloftIcon />,
  // Composio-managed (net-new)
  discord: <Icons.DiscordIcon />,
  airtable: <Icons.AirtableIcon />,
  typeform: <Icons.TypeformIcon />,
  freshbooks: <Icons.FreshbooksIcon />,
  // HR / ATS — coming_soon (NOT Composio-backed; see icon definitions above
  // and connector-service src/catalog/connectors.ts for context).
  workday: <Icons.WorkdayIcon />,
  lever: <Icons.LeverIcon />,
  workable: <Icons.WorkableIcon />,
  // HRIS brand marks. Types match connector-service catalog. UKG Pro and UKG
  // Ready share the one UKG wordmark.
  namely: <Icons.NamelyIcon />,
  sap_successfactors: <Icons.SapSuccessFactorsIcon />,
  oracle_hcm: <Icons.OracleHcmIcon />,
  zenefits: <Icons.ZenefitsIcon />,
  ukg_pro: <Icons.UkgIcon />,
  ukg_ready: <Icons.UkgIcon />,
  deel: <Icons.DeelIcon />,
  zoho_people: <Icons.ZohoPeopleIcon />,
  adp_workforce_now: <Icons.AdpWorkforceNowIcon />,
  adp_run: <Icons.AdpWorkforceNowIcon />,
  dayforce: <Icons.DayforceIcon />,
  paylocity: <Icons.PaylocityIcon />,
  paycor: <Icons.PaycorIcon />,
  paychex: <Icons.PaychexIcon />,
  hibob: <Icons.HiBobIcon />,
  personio: <Icons.PersonioIcon />,
  factorial: <Icons.FactorialIcon />,
  justworks: <Icons.JustworksIcon />,
  // Composio-managed coming_soon batch (review-bypass tiles).
  facebook: <Icons.FacebookIcon />,
  instagram: <Icons.InstagramIcon />,
  whatsapp: <Icons.WhatsAppIcon />,
  figma: <Icons.FigmaIcon />,
  canva: <Icons.CanvaIcon />,
  bitbucket: <Icons.BitbucketIcon />,
  pagerduty: <Icons.PagerDutyIcon />,
  // Google scope extension — ships via our GOOGLE_CLIENT_ID app, not Composio.
  youtube: <Icons.YouTubeIcon />,
  // BYOK web-tool vendors — tenant brings their own API key on /connections.
  firecrawl: <Icons.FirecrawlIcon />,
  anchor_browser: <Icons.AnchorBrowserIcon />,
  browser_use: <Icons.BrowserUseIcon />,
  steel: <Icons.SteelIcon />,
  browserbase: <Icons.BrowserbaseIcon />,
  // The saved logins the browsers sign in with (a 1Password service account).
  onepassword: <Icons.OnePasswordIcon />,
  tavily: <Icons.TavilyIcon />,
  exa: <Icons.ExaIcon />,
  webclaw: <Icons.WebClawIcon />,
  // Research — native sidecar (api_key); tenant brings their own Elicit key.
  elicit: <Icons.ElicitIcon />,
  // Additional Composio-managed connectors — workflow apps, product-analytics, e-sign (Composio CDN logos)
  clickup: <Icons.ClickUpIcon />,
  todoist: <Icons.TodoistIcon />,
  greenhouse: <Icons.GreenhouseIcon />,
  ashby: <Icons.AshbyIcon />,
  freshdesk: <Icons.FreshdeskIcon />,
  coda: <Icons.CodaIcon />,
  missive: <Icons.MissiveIcon />,
  fireflies: <Icons.FirefliesIcon />,
  fathom: <Icons.FathomIcon />,
  shopify: <Icons.ShopifyIcon />,
  gumroad: <Icons.GumroadIcon />,
  close: <Icons.CloseCrmIcon />,
  browseai: <Icons.BrowseAiIcon />,
  documint: <Icons.DocumintIcon />,
  posthog: <Icons.PostHogIcon />,
  mixpanel: <Icons.MixpanelIcon />,
  pandadoc: <Icons.PandaDocIcon />,
  // Capability-absorption data vendors — the user-visible ones.
  contactout: <Icons.ContactOutIcon />,
  crunchbase: <Icons.CrunchbaseIcon />,
  strale: <Icons.StraleIcon />,
  gloria: <Icons.GloriaIcon />,
  // Net-new Composio-managed batch
  activecampaign: <Icons.ActivecampaignIcon />,
  apify: <Icons.ApifyIcon />,
  baserow: <Icons.BaserowIcon />,
  brevo: <Icons.BrevoIcon />,
  buildkite: <Icons.BuildkiteIcon />,
  codacy: <Icons.CodacyIcon />,
  dovetail: <Icons.DovetailIcon />,
  elevenlabs: <Icons.ElevenlabsIcon />,
  fibery: <Icons.FiberyIcon />,
  fillout: <Icons.FilloutIcon />,
  folk: <Icons.FolkIcon />,
  follow_up_boss: <Icons.FollowUpBossIcon />,
  heygen: <Icons.HeygenIcon />,
  imgbb: <Icons.ImgbbIcon />,
  incident_io: <Icons.IncidentIoIcon />,
  jotform: <Icons.JotformIcon />,
  lemlist: <Icons.LemlistIcon />,
  lemon_squeezy: <Icons.LemonSqueezyIcon />,
  loops: <Icons.LoopsIcon />,
  mailerlite: <Icons.MailerliteIcon />,
  mailersend: <Icons.MailersendIcon />,
  mem: <Icons.MemIcon />,
  new_relic: <Icons.NewRelicIcon />,
  northflank: <Icons.NorthflankIcon />,
  paperform: <Icons.PaperformIcon />,
  scrapingbee: <Icons.ScrapingbeeIcon />,
  tally: <Icons.TallyIcon />,
  telegram: <Icons.TelegramIcon />,
  toggl: <Icons.TogglIcon />,
  clicksend: <Icons.ClicksendIcon />,
  ticktick: <Icons.TicktickIcon />,
  monday: <Icons.MondayIcon />,
  dialpad: <Icons.DialpadIcon />,
  harvest: <Icons.HarvestIcon />,
  google_meet: <Icons.GoogleMeetIcon />,
  zoho: <Icons.ZohoIcon />,
  zoho_bigin: <Icons.ZohoBiginIcon />,
  zoho_invoice: <Icons.ZohoIcon />,
  zoho_books: <Icons.ZohoIcon />,
  zoho_desk: <Icons.ZohoIcon />,
  zoho_inventory: <Icons.ZohoInventoryIcon />,
  zoho_mail: <Icons.ZohoIcon />,
}

// Backend connector-type aliases for icon lookup.
//
// Before Phase 4 of the catalog consolidation, the frontend referenced
// connectors by short IDs (`jira`, `confluence`, `onedrive`, ...) that
// came from src/data/integrations.json. The backend catalog uses fully
// qualified type names (`atlassian_jira`, `atlassian_confluence`,
// `microsoft_onedrive`, ...). These aliases let `getIntegrationIcon()`
// resolve either form to the same icon — the frontend now passes the
// backend type directly, and legacy callsites keep working.
const BACKEND_TYPE_ICON_ALIASES: Record<string, keyof typeof INTEGRATION_ICONS> = {
  atlassian_jira: 'jira',
  atlassian_confluence: 'confluence',
  microsoft_onedrive: 'onedrive',
  microsoft_contacts: 'outlook_contacts',
  google_bigquery: 'bigquery',
  google_firestore: 'firestore',
}

// Helper to get icon by integration ID with fallback
export const getIntegrationIcon = (id: string): ReactNode => {
  const direct = INTEGRATION_ICONS[id]
  if (direct) return direct
  const aliased = BACKEND_TYPE_ICON_ALIASES[id]
  if (aliased) return INTEGRATION_ICONS[aliased]
  return <Icons.WebsiteFormsIcon />
}
