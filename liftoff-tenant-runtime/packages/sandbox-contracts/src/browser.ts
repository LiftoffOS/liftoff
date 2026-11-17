// Browser API contract types
// Mirrors agent-infra/sandbox sdk/js/src/api/resources/browser/types
// 29 core verbs plus Liftoff additions (state, network interception, captcha).

export interface BrowserInfo {
  cdp_url: string;
  vnc_url: string;
  vscode_url?: string;
  version: string;
}

export interface BrowserScreenshotRequest {
  tabId: string;
  selector?: string;
  full_page?: boolean;
  encoding?: 'base64' | 'binary';
}

export interface BrowserScreenshotResponse {
  pngBase64: string;
}

export interface BrowserActionResult {
  success: boolean;
  data?: Record<string, unknown>;
}

export interface BrowserConfig {
  viewport?: { width: number; height: number };
  user_agent?: string;
  locale?: string;
  timezone_id?: string;
}

export interface BrowserRestartResponse {
  success: boolean;
  uptime_ms: number;
}

export interface BrowserPageHandle {
  tabId: string;
}

export interface BrowserTabInfo {
  tabId: string;
  url: string;
  title: string;
}

export interface BrowserNavigateRequest {
  tabId?: string;
  url: string;
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout_ms?: number;
}

export interface BrowserClickRequest {
  tabId: string;
  selector: string;
}

export interface BrowserFillRequest {
  tabId: string;
  selector: string;
  value: string;
}

export interface BrowserPressKeyRequest {
  tabId: string;
  key: string;
}

export interface BrowserEvaluateRequest {
  tabId: string;
  script: string;
}

export interface BrowserEvaluateResponse {
  result: unknown;
}

export interface BrowserExtractTextRequest {
  tabId: string;
  selector?: string;
}

export interface BrowserExtractTextResponse {
  text: string;
}

export interface BrowserExtractMarkdownRequest {
  tabId: string;
}

export interface BrowserExtractMarkdownResponse {
  markdown: string;
}

export interface BrowserListTabsResponse {
  tabs: BrowserTabInfo[];
}

export interface BrowserCloseTabRequest {
  tabId: string;
}

// Additional page methods (14.F)
export interface BrowserHotKeyRequest {
  tabId: string;
  keys: string;
}

export interface BrowserUploadFileRequest {
  tabId: string;
  selector: string;
  filePaths: string[];
}

export interface BrowserGetElementsRequest {
  tabId: string;
  selector: string;
}

export interface BrowserElement {
  tag: string;
  text: string;
  attrs: Record<string, string>;
}

export interface BrowserGetElementsResponse {
  elements: BrowserElement[];
}

export interface BrowserConsoleMessage {
  level: string;
  text: string;
  ts: number;
}

export interface BrowserGetConsoleRequest {
  tabId: string;
  since?: number;
}

export interface BrowserGetConsoleResponse {
  messages: BrowserConsoleMessage[];
}

export interface BrowserFindTextRequest {
  tabId: string;
  text: string;
}

export interface BrowserFindTextResponse {
  found: boolean;
  selector?: string;
  bounding_box?: { x: number; y: number; width: number; height: number };
}

export interface BrowserScrollToRequest {
  tabId: string;
  x: number;
  y: number;
}

export interface BrowserScrollToElementRequest {
  tabId: string;
  selector: string;
}

// State (14.G)
export interface BrowserStateSaveRequest {
  tabId: string;
  stateId?: string;
}

export interface BrowserStateSaveResponse {
  stateId: string;
  path: string;
}

export interface BrowserStateLoadRequest {
  stateId: string;
}

export interface BrowserStateLoadResponse {
  tabId: string;
}

export interface BrowserStateDescriptor {
  stateId: string;
  createdAt: string;
  size: number;
}

export interface BrowserStateListResponse {
  states: BrowserStateDescriptor[];
}

// Network interception (14.H)
export type BrowserRouteAction = 'block' | 'fulfill' | 'continue';

export interface BrowserRouteFulfillSpec {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface BrowserRouteAddRequest {
  tabId: string;
  urlPattern: string;
  action: BrowserRouteAction;
  fulfill?: BrowserRouteFulfillSpec;
}

export interface BrowserRouteHandle {
  routeId: string;
}

export interface BrowserRouteRemoveRequest {
  routeId: string;
}

export interface BrowserRouteDescriptor {
  routeId: string;
  tabId: string;
  urlPattern: string;
  action: BrowserRouteAction;
}

export interface BrowserRouteListResponse {
  routes: BrowserRouteDescriptor[];
}

export interface BrowserHeadersSetRequest {
  tabId: string;
  headers: Record<string, string>;
}

export interface BrowserHeadersScopedRequest {
  tabId: string;
  urlPattern: string;
  headers: Record<string, string>;
}

export interface BrowserCapturedRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  durationMs?: number;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  failed?: { errorText: string };
}

export interface BrowserRequestsListResponse {
  requests: BrowserCapturedRequest[];
}

// Captcha (14.K)
export type BrowserCaptchaType = 'recaptcha' | 'hcaptcha' | 'cloudflare' | 'turnstile';

export interface BrowserCaptchaDetectRequest {
  tabId: string;
}

export interface BrowserCaptchaDetectResponse {
  detected: boolean;
  type?: BrowserCaptchaType;
  selector?: string;
}

export interface BrowserCaptchaWaitRequest {
  tabId: string;
  timeout_ms?: number;
}

export interface BrowserCaptchaWaitResponse {
  solved: boolean;
  durationMs: number;
}

// Cookies
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface BrowserGetCookiesResponse {
  cookies: BrowserCookie[];
}

export interface BrowserSetCookiesRequest {
  tabId: string;
  cookies: BrowserCookie[];
}
