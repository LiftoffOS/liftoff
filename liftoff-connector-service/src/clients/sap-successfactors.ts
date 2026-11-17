// SAP SuccessFactors HXM Connector Client (native, first-party).
//
// Base: https://{apiServerHost}/odata/v2 (OData v2; v4 also available at /odata/v4)
// Auth: OAuth 2.0 SAML Bearer Assertion (help.sap.com "Requesting an Access Token").
//   POST https://{apiServerHost}/oauth/token   (application/x-www-form-urlencoded)
//     company_id   = the customer's SF company id
//     client_id    = API key of the OAuth2 client the customer registers in
//                    Admin Center → API Center → OAuth Configuration
//     grant_type   = urn:ietf:params:oauth:grant-type:saml2-bearer
//     assertion    = Base64 of a SAML 2.0 assertion signed with OUR X.509 private
//                    key (the customer uploads our PUBLIC cert onto their OAuth
//                    client). Response: { access_token, expires_in, token_type }.
//
// Customer-tenant-authorized: the customer registers the OAuth client + our cert
// in their own instance — no central SAP review of Liftoff. Fully native.
//
// Credential convention:
//   credentials.connectorConfig.{ apiServerHost, companyId, oauthClientId, assertionUserId }
//   private key   → process.env.SAP_SF_SAML_PRIVATE_KEY (PEM). One Liftoff keypair;
//                   the same public cert is registered per customer OAuth client.
//
// Signing: spec-correct enveloped XML-DSig via xml-crypto (RSA-SHA256, exclusive
// C14N, X.509 cert in KeyInfo, Signature after <Issuer>). Requires two PEMs in
// env — ONE Liftoff keypair; the same public cert is registered on each
// customer's OAuth client:
//   SAP_SF_SAML_PRIVATE_KEY  (PEM private key — signs the assertion)
//   SAP_SF_SAML_PUBLIC_CERT  (PEM X.509 cert — embedded in KeyInfo)
//
// DORMANT: not registered as an executor, no SAP_SUCCESSFACTORS_FUNCTIONS wired.

import { randomUUID } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import {
  CompensationClient,
  CredentialProvider,
  ConnectorCredentials,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';
import { isTemplatedEntity, templatedRead, templatedCreate, templatedUpdate, templatedDelete } from './templated-dispatch.js';
import { computeSapEmployerContribution } from './sap-employer-contribution.js';

/** OData Edm.DateTime serializes as "/Date(ms)/"; pull the epoch for comparison. */
function sfEpochOf(v: unknown): number {
  const m = String(v ?? '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}

/**
 * Reduce EmpPayCompRecurring rows to one current base-pay row per employee. Base
 * salary isn't a fixed pay-component code (tenant-configured Annualized-Salary
 * group), so per employee we keep the most-recent effective date, then the largest
 * paycompvalue among that date's rows — base pay is reliably the largest recurring
 * component. Exact base-pay isolation would use the tenant's pay-component group;
 * this heuristic captures it for the common case without per-tenant config.
 */
export function pickBaseCompensationRows(rows: Array<Record<string, unknown>>): ExternalRecord[] {
  const byUser = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const uid = String(r['userId'] ?? '');
    if (!uid) continue;
    const list = byUser.get(uid); if (list) list.push(r); else byUser.set(uid, [r]);
  }
  const out: ExternalRecord[] = [];
  for (const [uid, urows] of byUser) {
    const latestEpoch = urows.reduce((m, r) => Math.max(m, sfEpochOf(r['startDate'])), 0);
    const current = urows.filter((r) => sfEpochOf(r['startDate']) === latestEpoch);
    const base = current.reduce((a, b) => (Number(b['paycompvalue'] ?? 0) > Number(a['paycompvalue'] ?? 0) ? b : a));
    out.push({ id: uid, data: base });
  }
  return out;
}

interface SapConfig {
  apiServerHost: string;
  companyId: string;
  oauthClientId: string;
  assertionUserId: string;
  issuer: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Shared token cache keyed by companyId+oauthClientId. The executor builds a NEW
// client per tool call, so an instance-level cache would re-mint every request.
const tokenCache = new Map<string, CachedToken>();

export class SapSuccessFactorsClient implements CompensationClient {
  readonly connector = 'sap_successfactors';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private resolveConfig(credentials: ConnectorCredentials): SapConfig {
    const cfg = (credentials.connectorConfig ?? {}) as Record<string, unknown>;
    const apiServerHost = String(cfg.apiServerHost ?? cfg.apiServer ?? '');
    const companyId = String(cfg.companyId ?? '');
    const oauthClientId = String(cfg.oauthClientId ?? cfg.clientId ?? '');
    const assertionUserId = String(cfg.assertionUserId ?? cfg.userId ?? '');
    if (!apiServerHost || !companyId || !oauthClientId || !assertionUserId) {
      throw new Error('SAP SuccessFactors credential missing apiServerHost/companyId/oauthClientId/assertionUserId in connectorConfig');
    }
    // SAP matches the SAML Issuer against the OAuth client config; default to the
    // API key (client id), overridable per instance via connectorConfig.samlIssuer.
    const issuer = String(cfg.samlIssuer ?? oauthClientId);
    return { apiServerHost, companyId, oauthClientId, assertionUserId, issuer };
  }

  /**
   * Build a Base64-encoded, enveloped-signed SAML 2.0 bearer assertion per SAP's
   * "OAuth2 SAML Bearer Assertion" spec. Signature: RSA-SHA256 over the
   * exclusive-C14N'd assertion (xml-crypto), Signature placed after <Issuer>,
   * X.509 cert in KeyInfo — spec-correct, no placeholder.
   */
  private buildSignedSamlAssertion(cfg: SapConfig): string {
    const privateKey = process.env.SAP_SF_SAML_PRIVATE_KEY;
    const publicCert = process.env.SAP_SF_SAML_PUBLIC_CERT;
    if (!privateKey) {
      throw new Error('SAP SuccessFactors: SAP_SF_SAML_PRIVATE_KEY env (PEM) is not set');
    }
    if (!publicCert) {
      throw new Error('SAP SuccessFactors: SAP_SF_SAML_PUBLIC_CERT env (PEM X.509) is not set');
    }
    const now = Date.now();
    const notBefore = new Date(now - 60_000).toISOString();
    const notOnOrAfter = new Date(now + 10 * 60_000).toISOString();
    const issueInstant = new Date(now).toISOString();
    const assertionId = `_${randomUUID()}`;
    const tokenUrl = `https://${cfg.apiServerHost}/oauth/token`;

    const assertion =
      `<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${issueInstant}" Version="2.0">` +
      `<saml2:Issuer>${cfg.issuer}</saml2:Issuer>` +
      `<saml2:Subject>` +
      `<saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${cfg.assertionUserId}</saml2:NameID>` +
      `<saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${tokenUrl}"/>` +
      `</saml2:SubjectConfirmation>` +
      `</saml2:Subject>` +
      `<saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
      `<saml2:AudienceRestriction><saml2:Audience>www.successfactors.com</saml2:Audience></saml2:AudienceRestriction>` +
      `</saml2:Conditions>` +
      `<saml2:AuthnStatement AuthnInstant="${issueInstant}">` +
      `<saml2:AuthnContext><saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PreviousSession</saml2:AuthnContextClassRef></saml2:AuthnContext>` +
      `</saml2:AuthnStatement>` +
      `</saml2:Assertion>`;

    const sig = new SignedXml({ privateKey, publicCert });
    sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    // SAML requires the Signature to sit immediately after <Issuer>.
    sig.computeSignature(assertion, {
      location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
    });
    return Buffer.from(sig.getSignedXml(), 'utf8').toString('base64');
  }

  private async mintToken(cfg: SapConfig): Promise<string> {
    const cacheKey = `${cfg.companyId}::${cfg.oauthClientId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.accessToken;
    }
    const assertion = this.buildSignedSamlAssertion(cfg);
    const form = new URLSearchParams({
      company_id: cfg.companyId,
      client_id: cfg.oauthClientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:saml2-bearer',
      assertion,
    });
    const res = await fetch(`https://${cfg.apiServerHost}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      throw new Error(`SAP SuccessFactors token error: ${res.status} - ${text}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    const entry: CachedToken = {
      accessToken: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 1440) * 1000,
    };
    tokenCache.set(cacheKey, entry);
    return entry.accessToken;
  }

  private async odata<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    const cfg = this.resolveConfig(credentials);
    const token = await this.mintToken(cfg);

    let url = `https://${cfg.apiServerHost}/odata/v2${path}`;
    const q = new URLSearchParams(query ?? {});
    if (!q.has('$format')) q.set('$format', 'json');
    url = `${url}?${q.toString()}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      logger.error('SAP SuccessFactors OData error', { status: res.status, path, method });
      throw new Error(`SAP SuccessFactors OData error: ${res.status} - ${text}`);
    }
    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  // OData entity set for an entityType. Free-form: the caller may pass any EC
  // entity set name (User, EmpEmployment, EmpJob, EmpCompensation, ...).
  private entitySet(entityType: string): string {
    const map: Record<string, string> = {
      users: 'User', user: 'User',
      employments: 'EmpEmployment', employment: 'EmpEmployment',
      jobs: 'EmpJob', job: 'EmpJob',
      compensations: 'EmpCompensation', compensation: 'EmpCompensation',
      pay_components: 'EmpPayCompRecurring',
      persons: 'PerPerson', person: 'PerPerson',
      personal: 'PerPersonal',
      time: 'EmployeeTime', employee_time: 'EmployeeTime',
    };
    return map[entityType] ?? entityType;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(this.odata.bind(this), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('SAP native_request: path must start with "/"');
      const data = await this.odata<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    const set = this.entitySet(entityType);
    if (entityId) {
      const data = await this.odata<{ d?: Record<string, unknown> }>('GET', `/${set}(${this.keyPredicate(entityId)})`);
      return { id: entityId, data: (data.d ?? data) as Record<string, unknown> };
    }
    const query = this.buildODataQuery(payload);
    const data = await this.odata<{ d?: { results?: unknown[] } }>('GET', `/${set}`, undefined, query);
    return { id: set, data: { results: data.d?.results ?? [] } };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Base pay lives in EmpPayCompRecurring (paycompvalue/currencyCode), NOT
    // EmpCompensation (which holds no scalar amount). Base salary isn't a fixed
    // pay-component code — it's tenant-configured (Annualized Salary pay-component
    // group) — so we pick, per employee, the most-recent effective row with the
    // largest paycompvalue (base pay is reliably the largest recurring component).
    if (entityType === 'base_compensation') return { records: await this.listBaseCompensation(), hasMore: false };
    if (entityType === 'sap_employer_match') return { records: await this.listEmployerMatchContributions(), hasMore: false };
    const set = this.entitySet(entityType);
    const query: Record<string, string> = {};
    if (filters?.limit) query['$top'] = String(filters.limit);
    if (filters?.pageToken) query['$skip'] = filters.pageToken;
    const data = await this.odata<{ d?: { results?: Array<Record<string, unknown>> } }>('GET', `/${set}`, undefined, query);
    const rows = data.d?.results ?? [];
    const records = rows
      .filter((r) => r && (r.userId ?? r.personIdExternal ?? r.externalCode ?? r.id) != null)
      .map((r) => ({ id: String(r.userId ?? r.personIdExternal ?? r.externalCode ?? r.id), data: r }));
    return { records, hasMore: rows.length === (filters?.limit ?? rows.length) && rows.length > 0 };
  }

  /**
   * Current base annual pay per employee, from EmpPayCompRecurring. amount=paycompvalue,
   * currency=currencyCode. See pickBaseCompensationRows for the group + pick logic.
   */
  private async listBaseCompensation(): Promise<ExternalRecord[]> {
    const data = await this.odata<{ d?: { results?: Array<Record<string, unknown>> } }>(
      'GET', '/EmpPayCompRecurring', undefined,
      { $select: 'userId,paycompvalue,currencyCode,payComponent,frequency,startDate' });
    return pickBaseCompensationRows(data.d?.results ?? []);
  }

  /**
   * Per-employee employer benefit contributions for savings/pension plans. SAP Global Benefits
   * models the employer share as PLAN CONFIG (not a materialized per-employee amount), so we join
   * several reads client-side and compute per enrollment:
   *   - PensionEmployerContributionDetail → employer config per benefit (type/amount/percentage +
   *     statutory floor). VERIFIED fields: employerContributionAmount/Percentage/Type,
   *     employerStatutoryMinimumAmount/Percentage.
   *   - PensionBenefitDetails → links a benefit to its min/max + banding config tables.
   *   - BenefitPensionMinMaxContributionLimits → employer clamp. VERIFIED: erMin/erMaxContributionAmount.
   *   - PensionBandingConfiguration(+Details, $expanded) → tiered match. VERIFIED: lowerBandValue,
   *     upperBandValue, employerPercentage.
   *   - BenefitSavingsPlanEnrollmentDetails → the employee's own per-period contribution (the base a
   *     percentage/tier applies to), keyed by BenefitEnrollment_id.
   *   - BenefitEnrollment → the per-employee header. VERIFIED from a reference-guide sample:
   *     workerId (employee), a scalar `benefit` external code, id, effectiveStartDate.
   * computeSapEmployerContribution turns config + base into the per-employee employer amount.
   * All join keys and contribution/limit/banding LEAF fields are verified against the SAP OData
   * reference guide (fields + a live sample); paging follows d.__next ($skiptoken). The one remaining
   * live-tenant nuance is the exact contribution BASE per pension plan type (we use the savings
   * enrollment's per-period contribution) — everything else is doc-verified.
   */
  private async listEmployerMatchContributions(): Promise<ExternalRecord[]> {
    const results = async (set: string): Promise<Array<Record<string, unknown>>> => {
      const all: Array<Record<string, unknown>> = [];
      try {
        // SAP SF OData v2 uses server-side cursor paging: each response carries d.__next with a
        // $skiptoken to fetch the next page (verified from the reference guide's sample URIs). Follow
        // __next until it's absent; cap at 100 pages as a runaway guard.
        let skiptoken: string | undefined;
        for (let guard = 0; guard < 100; guard++) {
          const query: Record<string, string> = skiptoken ? { $skiptoken: skiptoken } : { $top: '200' };
          const data = await this.odata<{ d?: { results?: Array<Record<string, unknown>>; __next?: string } }>('GET', `/${set}`, undefined, query);
          const rows = data.d?.results ?? [];
          all.push(...rows);
          const next = data.d?.__next;
          const tm = next ? String(next).match(/\$skiptoken=([^&]+)/) : null;
          if (!tm || rows.length === 0) break;
          skiptoken = decodeURIComponent(tm[1]);
        }
      } catch (e) {
        logger.warn('SAP employer-match: entity unavailable', { set, err: (e as Error).message });
      }
      return all;
    };
    const str = (v: unknown): string => (v == null ? '' : String(v));
    const firstKey = (r: Record<string, unknown>, keys: string[]): unknown => { for (const k of keys) if (r[k] != null) return r[k]; return undefined; };

    // 1) Employer contribution config per benefit plan.
    const configByBenefit = new Map<string, Record<string, unknown>>();
    for (const c of await results('PensionEmployerContributionDetail')) {
      const benefitId = str(firstKey(c, ['Benefit_benefitId', 'benefitId', 'PensionBenefitDetails_externalCode']));
      if (benefitId) configByBenefit.set(benefitId, c);
    }
    if (configByBenefit.size === 0) return [];

    // 1a) Benefit → its config-table references. SAP keeps min/max limits and banding as separate
    // config tables; PensionBenefitDetails links a benefit to them via `pensionMinMaxContributionLimits`
    // (→ BenefitPensionMinMaxContributionLimits.configurationTableId) and `bandingsConfiguration`
    // (→ PensionBandingConfiguration.bandingConfigurationId). Field names verified against the SAP
    // OData reference; the scalar-vs-nav shape of these link fields needs live-tenant confirmation.
    const benefitConfigRefs = new Map<string, { bandingConfigId?: string; minMaxConfigId?: string }>();
    for (const pbd of await results('PensionBenefitDetails')) {
      const benefitId = str(firstKey(pbd, ['Benefit_benefitId', 'benefitId']));
      if (!benefitId) continue;
      benefitConfigRefs.set(benefitId, {
        bandingConfigId: str(firstKey(pbd, ['bandingsConfiguration', 'bandingConfigurationId'])) || undefined,
        minMaxConfigId: str(firstKey(pbd, ['pensionMinMaxContributionLimits', 'configurationTableId'])) || undefined,
      });
    }

    // 1b) Min/max EMPLOYER contribution limits, keyed by config-table id. Verified fields on
    // BenefitPensionMinMaxContributionLimits: erMinContributionAmount / erMaxContributionAmount.
    const limitsByConfig = new Map<string, { min?: number; max?: number }>();
    for (const l of await results('BenefitPensionMinMaxContributionLimits')) {
      const configId = str(firstKey(l, ['configurationTableId', 'configurationTableName']));
      if (!configId) continue;
      const min = Number(firstKey(l, ['erMinContributionAmount']));
      const max = Number(firstKey(l, ['erMaxContributionAmount']));
      limitsByConfig.set(configId, {
        min: Number.isFinite(min) ? min : undefined,
        max: Number.isFinite(max) ? max : undefined,
      });
    }

    // 1c) Banding/tiered EMPLOYER match, grouped by banding-config id. Verified fields on
    // PensionBandingConfigurationDetails: lowerBandValue / upperBandValue / employerPercentage. Fetch
    // PensionBandingConfiguration with its details $expanded so bands group under their config id;
    // each band matches the base slice up to upperBandValue at employerPercentage.
    const tiersByConfig = new Map<string, Array<{ upTo: number | null; matchPercent: number }>>();
    try {
      const cfgs = (await this.odata<{ d?: { results?: Array<Record<string, unknown>> } }>(
        'GET', '/PensionBandingConfiguration', undefined, { $expand: 'pensionBandingConfigurationDetails', $top: '500' })).d?.results ?? [];
      for (const cfg of cfgs) {
        const configId = str(firstKey(cfg, ['bandingConfigurationId']));
        if (!configId) continue;
        const node = cfg['pensionBandingConfigurationDetails'] as { results?: Array<Record<string, unknown>> } | undefined;
        const details = Array.isArray(node?.results) ? node!.results : [];
        const tiers: Array<{ upTo: number | null; matchPercent: number }> = [];
        for (const d of details) {
          const rate = Number(firstKey(d, ['employerPercentage']));
          if (!Number.isFinite(rate)) continue;
          const upperRaw = firstKey(d, ['upperBandValue']);
          const upTo = upperRaw == null || upperRaw === '' ? null : Number(upperRaw);
          tiers.push({ upTo: Number.isFinite(upTo as number) ? (upTo as number) : null, matchPercent: rate });
        }
        if (tiers.length) tiersByConfig.set(configId, tiers);
      }
    } catch (e) {
      logger.warn('SAP employer-match: banding configuration unavailable', { err: (e as Error).message });
    }

    // 2) Per-enrollment employee contribution base.
    const baseByEnrollment = new Map<string, number>();
    for (const d of await results('BenefitSavingsPlanEnrollmentDetails')) {
      const enrollId = str(firstKey(d, ['BenefitEnrollment_id', 'benefitEnrollmentId']));
      const perPeriod = Number(firstKey(d, ['payPeriodContributionAmount']) ?? 0);
      const annual = Number(firstKey(d, ['annualContributionAmount']) ?? 0);
      const base = perPeriod > 0 ? perPeriod : annual > 0 ? annual / 12 : 0;
      if (enrollId) baseByEnrollment.set(enrollId, base);
    }

    // 3) Per-employee enrollment header → compute the employer amount.
    const out: ExternalRecord[] = [];
    for (const e of await results('BenefitEnrollment')) {
      // Verified from the reference guide sample: the enrollment carries workerId (employee) and a
      // scalar `benefit` (the benefit's external code, e.g. "INSURANCE_BEN_REC_INFO"); `id` is the
      // enrollment key that BenefitSavingsPlanEnrollmentDetails.BenefitEnrollment_id references.
      const userId = str(firstKey(e, ['workerId', 'userId']));
      const benefitId = str(firstKey(e, ['benefit', 'benefitId', 'Benefit_benefitId']));
      const enrollId = str(firstKey(e, ['id', 'externalCode', 'benefitEnrollmentEntityID']));
      if (!userId || !benefitId) continue;
      const cfg = configByBenefit.get(benefitId);
      if (!cfg) continue; // only benefits carrying an employer contribution config
      const refs = benefitConfigRefs.get(benefitId);
      const limits = refs?.minMaxConfigId ? limitsByConfig.get(refs.minMaxConfigId) : undefined;
      const tiers = refs?.bandingConfigId ? tiersByConfig.get(refs.bandingConfigId) : undefined;
      const employer = computeSapEmployerContribution({
        type: firstKey(cfg, ['employerContributionType']) as string | undefined,
        amount: firstKey(cfg, ['employerContributionAmount']),
        percentage: firstKey(cfg, ['employerContributionPercentage']),
        statutoryMinimumAmount: firstKey(cfg, ['employerStatutoryMinimumAmount']),
        statutoryMinimumPercentage: firstKey(cfg, ['employerStatutoryMinimumPercentage']),
        minAmount: limits?.min,
        maxAmount: limits?.max,
        tiers,
      }, baseByEnrollment.get(enrollId) ?? 0);
      if (employer == null) continue;
      out.push({ id: `${userId}:${benefitId}`, data: {
        userId, benefitId, enrollmentId: enrollId,
        effectiveStartDate: firstKey(e, ['effectiveStartDate', 'benefitEffectiveStartDate']),
        employerContributionAmount: String(employer),
        employerContributionPercentage: firstKey(cfg, ['employerContributionPercentage']),
        benefitType: 'retirement',
      } });
    }
    return out;
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(this.odata.bind(this), {}, entityType, data);
    try {
      if (entityType === 'native') {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'SAP native_request: path must start with "/"' };
        const result = await this.odata<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined);
        return { success: true, id: 'native', data: result };
      }
      // SuccessFactors writes are OData "upsert" — POST /upsert with __metadata.uri.
      const set = this.entitySet(entityType);
      const upsertBody = { __metadata: { uri: set }, ...data };
      const result = await this.odata<Record<string, unknown>>('POST', '/upsert', upsertBody);
      return { success: true, id: String((data.externalCode ?? data.userId ?? '') as string), data: result };
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.odata.bind(this), {}, entityType, entityId, data);
    try {
      if (entityType === 'native') {
        const method = String(data.method ?? 'MERGE').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'SAP native_request: path must start with "/"' };
        const result = await this.odata<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined);
        return { success: true, data: result };
      }
      if (!entityId) return { success: false, error: `SAP: update ${entityType} requires entityId` };
      // OData v2 partial update — MERGE to the keyed entity (unambiguous update,
      // vs upsert which relies on key fields being present in the body).
      const set = this.entitySet(entityType);
      const result = await this.odata<Record<string, unknown>>('MERGE', `/${set}(${this.keyPredicate(entityId)})`, data);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(entityType: string, entityId: string | undefined, _payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(this.odata.bind(this), {}, entityType, entityId, _payload);
    try {
      if (!entityId) return { success: false, error: `SAP: delete ${entityType} requires entityId` };
      const set = this.entitySet(entityType);
      await this.odata<void>('DELETE', `/${set}(${this.keyPredicate(entityId)})`);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create' && entityId) return this.delete(entityType, entityId);
    return { success: false, error: `SAP: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }

  /**
   * OData key predicate for the entity URL. Single-key entities pass a bare
   * value (`'123'`); composite-key entities (e.g. EmpJob, EmpCompensation) pass
   * a full predicate such as `userId='X',startDate=datetime'2026-01-01T00:00:00'`
   * — detected by the presence of `=` — which is used verbatim.
   */
  private keyPredicate(entityId: string): string {
    return entityId.includes('=') ? entityId : `'${entityId}'`;
  }

  private buildODataQuery(payload?: Record<string, unknown>): Record<string, string> {
    if (!payload) return {};
    const q: Record<string, string> = {};
    for (const key of ['$filter', '$select', '$expand', '$top', '$skip', '$orderby']) {
      if (payload[key] != null) q[key] = String(payload[key]);
    }
    return q;
  }
}
