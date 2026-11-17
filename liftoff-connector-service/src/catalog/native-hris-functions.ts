// First-class tool definitions for the fifteen native HRIS connectors.
//
// DORMANT: this module is intentionally NOT imported by connector-functions-
// registry.ts, so none of these tools are served today. They are the ready-to-
// wire first-class surface for each native client; at cutover the registry
// assigns CONNECTOR_FUNCTIONS[type] = <VENDOR>_FUNCTIONS for whichever connectors
// are flipped native. Defining them here (rather than at cutover) means the whole
// implementation — clients + tools — exists and is reviewable up front, with the
// cutover being a pure activation.
//
// Each entry maps to its client's read/list/create/update/delete(entityType, …)
// via the adapter's CRUD inference (name prefix + categories). `native` = the raw
// passthrough escape hatch (fail-secure HITL). categories drive dispatch + HITL:
// ['read'] → read; ['write'] + update-prefix → update, else create; ['destructive']
// → delete. Every set ends with the {vendor}_native_request passthrough.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorFunction, JsonSchemaProperty } from '../types.js';

// The exhaustive per-endpoint sets (emitted by `npm run gen:connector-tools` from the
// real vendor specs) are DATA, not code — the Oracle set alone is 8037 tools / 7.8MB.
// They ship as JSON and are read at runtime here, so tsc/eslint/jest never process
// them (a typed TS literal that big pushed tsc to 2.66GB and OOM'd CI). In dev/tests
// __dirname is src/catalog; in the built image it's dist/catalog, where the build
// copies the JSON alongside (scripts/copy-generated-assets.js). Shape is validated at
// generation time (spec-codegen validateOps), replacing the tsc check we drop here.
function loadGenerated(name: string): ConnectorFunction[] {
  return JSON.parse(readFileSync(join(__dirname, 'generated', `${name}.generated.json`), 'utf8')) as ConnectorFunction[];
}

const idSchema = (label: string) => ({
  type: 'object' as const,
  properties: { id: { type: 'string', description: label } },
  required: ['id'],
});
const emptySchema = { type: 'object' as const, properties: {} };
// Schema for a single non-`id` path parameter (e.g. worker_id, xrefCode, aoid).
const pathParamSchema = (param: string, label: string) => ({
  type: 'object' as const,
  properties: { [param]: { type: 'string', description: label } },
  required: [param],
});
const nativeSchema = {
  type: 'object' as const,
  properties: {
    method: { type: 'string', description: 'HTTP method (GET/POST/PUT/PATCH/MERGE/DELETE).' },
    path: { type: 'string', description: 'API path starting with "/".' },
    query: { type: 'object', description: 'Optional query parameters.' },
    body: { type: 'object', description: 'Optional JSON request body.' },
  },
  required: ['method', 'path'],
};
const nativeTool = (vendor: string, name: string): ConnectorFunction => ({
  name,
  description: `Make a raw request to any ${vendor} API endpoint (method, path, query, body). Use for endpoints not exposed as a dedicated tool.`,
  inputSchema: nativeSchema,
  categories: ['write'],
  entityType: 'native',
});

// Hand-authored drift `responseSchema` for curated connectors whose vendors publish NO fetchable
// OpenAPI spec (hibob/dayforce/adp/oracle_hcm), so the codegen (spec-codegen.ts) can't emit one.
// We assert only the top-level container the vendor wraps its collection under — the
// highest-signal, lowest-false-positive drift check: a bare-array/scalar or a renamed container
// fires, while per-field shapes (which we can't know without a live payload) are deliberately left
// open (additionalProperties) and backfilled by Phase-4 captured samples. The key must match the
// client's post-unwrap return: templatedRead returns `{id, data:<raw body>}` and the Oracle bare
// `read('workers')` returns `{id, data:{items:[...]}}`; the drift checker unwraps the `{id,data}`
// envelope, so `data`'s top-level key is what we assert here.
const listUnder = (key: string): JsonSchemaProperty => ({
  type: 'object',
  properties: { [key]: { type: 'array', items: { type: 'object' } } },
});

// ── Gusto ────────────────────────────────────────────────────────────────────
export const GUSTO_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_employees', description: 'List employees for the connected Gusto company.', inputSchema: emptySchema, categories: ['read'], entityType: 'employees' },
  { name: 'get_employee', description: 'Get a Gusto employee by UUID.', inputSchema: idSchema('Employee UUID.'), categories: ['read'], entityType: 'employee' },
  { name: 'list_payrolls', description: 'List payrolls for the connected Gusto company.', inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } } }, categories: ['read'], entityType: 'payrolls' },
  { name: 'get_payroll', description: 'Get a Gusto payroll by UUID.', inputSchema: idSchema('Payroll UUID.'), categories: ['read'], entityType: 'payroll' },
  { name: 'list_pay_statements', description: 'List Gusto per-employee pay statements across processed payrolls (flattened employee_compensations with per-employee employer taxes + benefit company contributions).', inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } } }, categories: ['read'], entityType: 'pay_statements' },
  { name: 'list_gusto_contractor_payments', description: 'List Gusto per-contractor payments (contractor_uuid, date, wage+reimbursement+bonus, payment method) from GET /companies/{company_id}/contractor_payments.', inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } } }, categories: ['read'], entityType: 'gusto_contractor_payments' },
  { name: 'list_time_off_requests', description: 'List time-off requests for the connected Gusto company.', inputSchema: emptySchema, categories: ['read'], entityType: 'time_off_requests' },
  { name: 'get_time_off_request', description: 'Get a single Gusto time-off request by id.', inputSchema: idSchema('Time-off request id.'), categories: ['read'], entityType: 'time_off_request' },
  { name: 'list_company_benefits', description: 'List benefits offered by the connected Gusto company.', inputSchema: emptySchema, categories: ['read'], entityType: 'company_benefits' },
  { name: 'create_employee', description: 'Create an employee in the connected Gusto company.', inputSchema: { type: 'object', properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, date_of_birth: { type: 'string' } }, required: ['first_name', 'last_name'] }, categories: ['write'], entityType: 'employee' },
  { name: 'update_employee', description: 'Update a Gusto employee (version is fetched automatically if omitted).', inputSchema: idSchema('Employee UUID.'), categories: ['write'], entityType: 'employee' },
  { name: 'terminate_employee', description: 'Terminate (delete) a Gusto employee.', inputSchema: idSchema('Employee UUID.'), categories: ['destructive'], entityType: 'employee' },
  nativeTool('Gusto', 'gusto_native_request'),
];

// ── Rippling ──────────────────────────────────────────────────────────────────
export const RIPPLING_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_workers', description: 'List workers (expands user/manager/compensation/department).', inputSchema: emptySchema, categories: ['read'], entityType: 'workers' },
  { name: 'get_worker', description: 'Get a Rippling worker by id.', inputSchema: idSchema('Worker id.'), categories: ['read'], entityType: 'worker' },
  { name: 'list_companies', description: 'Get the connected Rippling company.', inputSchema: emptySchema, categories: ['read'], entityType: 'companies' },
  { name: 'list_departments', description: 'List Rippling departments.', inputSchema: emptySchema, categories: ['read'], entityType: 'departments' },
  { name: 'get_department', description: 'Get a Rippling department by id.', inputSchema: idSchema('Department id.'), categories: ['read'], entityType: 'department' },
  { name: 'list_users', description: 'List Rippling users.', inputSchema: emptySchema, categories: ['read'], entityType: 'users' },
  { name: 'get_user', description: 'Get a Rippling user by id.', inputSchema: idSchema('User id.'), categories: ['read'], entityType: 'user' },
  { name: 'list_leave_requests', description: 'List Rippling leave (time-off) requests.', inputSchema: emptySchema, categories: ['read'], entityType: 'leave_requests' },
  { name: 'create_worker', description: 'Create a Rippling worker (where supported by the granted scopes).', inputSchema: emptySchema, categories: ['write'], entityType: 'worker' },
  { name: 'update_worker', description: 'Update a Rippling worker by id.', inputSchema: idSchema('Worker id.'), categories: ['write'], entityType: 'worker' },
  nativeTool('Rippling', 'rippling_native_request'),
];

// ── Namely ────────────────────────────────────────────────────────────────────
export const NAMELY_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_profiles', description: 'List Namely employee profiles.', inputSchema: emptySchema, categories: ['read'], entityType: 'profiles' },
  { name: 'get_profile', description: 'Get a Namely profile by id.', inputSchema: idSchema('Profile id.'), categories: ['read'], entityType: 'profile' },
  { name: 'create_profile', description: 'Create a Namely profile.', inputSchema: { type: 'object', properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' } }, required: ['first_name', 'last_name'] }, categories: ['write'], entityType: 'profile' },
  { name: 'update_profile', description: 'Update a Namely profile by id.', inputSchema: idSchema('Profile id.'), categories: ['write'], entityType: 'profile' },
  { name: 'deactivate_profile', description: 'Deactivate a Namely profile (sets user_status inactive; Namely has no hard delete).', inputSchema: idSchema('Profile id.'), categories: ['destructive'], entityType: 'profile' },
  { name: 'list_job_titles', description: 'List Namely job titles.', inputSchema: emptySchema, categories: ['read'], entityType: 'job_titles' },
  { name: 'list_groups', description: 'List Namely groups/teams.', inputSchema: emptySchema, categories: ['read'], entityType: 'groups' },
  { name: 'get_group', description: 'Get a Namely group by id.', inputSchema: idSchema('Group id.'), categories: ['read'], entityType: 'group' },
  { name: 'list_events', description: 'List Namely company feed events (NOT time-off).', inputSchema: emptySchema, categories: ['read'], entityType: 'events' },
  { name: 'list_reports', description: 'List Namely reports.', inputSchema: emptySchema, categories: ['read'], entityType: 'reports' },
  { name: 'get_report', description: 'Get a Namely report by id.', inputSchema: idSchema('Report id.'), categories: ['read'], entityType: 'report' },
  { name: 'list_profile_fields', description: 'List Namely custom profile-field definitions.', inputSchema: emptySchema, categories: ['read'], entityType: 'fields' },
  nativeTool('Namely', 'namely_native_request'),
];

// ── SAP SuccessFactors ────────────────────────────────────────────────────────
export const SAP_SUCCESSFACTORS_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_users', description: 'Query SuccessFactors User entities (OData $filter/$select/$expand supported).', inputSchema: { type: 'object', properties: { $filter: { type: 'string' }, $select: { type: 'string' }, $expand: { type: 'string' } } }, categories: ['read'], entityType: 'users' },
  { name: 'get_user', description: 'Get a SuccessFactors User by userId (or composite key predicate).', inputSchema: idSchema('userId, or a full OData key predicate for composite keys.'), categories: ['read'], entityType: 'user' },
  { name: 'list_employments', description: 'Query EmpEmployment entities.', inputSchema: emptySchema, categories: ['read'], entityType: 'employments' },
  { name: 'list_jobs', description: 'Query EmpJob (job history) entities.', inputSchema: emptySchema, categories: ['read'], entityType: 'jobs' },
  { name: 'list_compensations', description: 'Query EmpCompensation entities.', inputSchema: emptySchema, categories: ['read'], entityType: 'compensations' },
  { name: 'list_pay_components', description: 'Query EmpPayCompRecurring (recurring pay component) entities.', inputSchema: emptySchema, categories: ['read'], entityType: 'pay_components' },
  // Current base pay per employee, derived from EmpPayCompRecurring (client-side
  // group + max-value pick). EmpCompensation carries no scalar amount.
  { name: 'list_base_compensation', description: 'List current base compensation per employee (largest recurring EmpPayCompRecurring component).', inputSchema: emptySchema, categories: ['read'], entityType: 'base_compensation', useListMethod: true },
  { name: 'list_persons', description: 'Query PerPerson entities.', inputSchema: emptySchema, categories: ['read'], entityType: 'persons' },
  { name: 'list_employee_time', description: 'Query EmployeeTime (time off) entities.', inputSchema: emptySchema, categories: ['read'], entityType: 'time' },
  { name: 'get_employment', description: 'Get an EmpEmployment record by key.', inputSchema: idSchema('userId, or a full OData key predicate.'), categories: ['read'], entityType: 'employment' },
  { name: 'get_job', description: 'Get an EmpJob (job history) record by composite key.', inputSchema: idSchema("Full OData key predicate, e.g. userId='X',startDate=datetime'…'."), categories: ['read'], entityType: 'job' },
  { name: 'get_compensation', description: 'Get an EmpCompensation record by composite key.', inputSchema: idSchema('Full OData key predicate for EmpCompensation.'), categories: ['read'], entityType: 'compensation' },
  { name: 'get_pay_component', description: 'Get an EmpPayCompRecurring record by composite key.', inputSchema: idSchema('Full OData key predicate for EmpPayCompRecurring.'), categories: ['read'], entityType: 'pay_components' },
  { name: 'get_person', description: 'Get a PerPerson record by key (personIdExternal).', inputSchema: idSchema('personIdExternal, or a full OData key predicate.'), categories: ['read'], entityType: 'person' },
  { name: 'get_personal', description: 'Get a PerPersonal record by composite key.', inputSchema: idSchema('Full OData key predicate for PerPersonal.'), categories: ['read'], entityType: 'personal' },
  { name: 'get_employee_time', description: 'Get an EmployeeTime (time off) record by key.', inputSchema: idSchema('EmployeeTime external code / key predicate.'), categories: ['read'], entityType: 'time' },
  { name: 'create_user', description: 'Upsert a SuccessFactors User (OData upsert).', inputSchema: emptySchema, categories: ['write'], entityType: 'user' },
  { name: 'update_user', description: 'Update a SuccessFactors User (OData MERGE by key/predicate).', inputSchema: idSchema('userId, or a full OData key predicate.'), categories: ['write'], entityType: 'user' },
  { name: 'create_employment', description: 'Upsert an EmpEmployment record (OData upsert).', inputSchema: emptySchema, categories: ['write'], entityType: 'employment' },
  { name: 'update_employment', description: 'Update an EmpEmployment record (OData MERGE by key).', inputSchema: idSchema('userId, or a full OData key predicate.'), categories: ['write'], entityType: 'employment' },
  { name: 'create_job', description: 'Upsert an EmpJob (job history) record (OData upsert).', inputSchema: emptySchema, categories: ['write'], entityType: 'job' },
  { name: 'update_job', description: 'Update an EmpJob record (OData MERGE by composite key).', inputSchema: idSchema('Full OData key predicate for EmpJob.'), categories: ['write'], entityType: 'job' },
  { name: 'create_compensation', description: 'Upsert an EmpCompensation record (OData upsert). Financial — HITL-gated.', inputSchema: emptySchema, categories: ['write'], entityType: 'compensation' },
  { name: 'update_compensation', description: 'Update an EmpCompensation record (OData MERGE by key). Financial — HITL-gated.', inputSchema: idSchema('Full OData key predicate for EmpCompensation.'), categories: ['write'], entityType: 'compensation' },
  { name: 'create_pay_component', description: 'Upsert an EmpPayCompRecurring record (OData upsert). Financial — HITL-gated.', inputSchema: emptySchema, categories: ['write'], entityType: 'pay_components' },
  { name: 'update_pay_component', description: 'Update an EmpPayCompRecurring record (OData MERGE by key). Financial — HITL-gated.', inputSchema: idSchema('Full OData key predicate for EmpPayCompRecurring.'), categories: ['write'], entityType: 'pay_components' },
  { name: 'create_person', description: 'Upsert a PerPerson record (OData upsert).', inputSchema: emptySchema, categories: ['write'], entityType: 'person' },
  { name: 'update_person', description: 'Update a PerPerson record (OData MERGE by key).', inputSchema: idSchema('personIdExternal, or a full OData key predicate.'), categories: ['write'], entityType: 'person' },
  { name: 'create_personal', description: 'Upsert a PerPersonal record (OData upsert).', inputSchema: emptySchema, categories: ['write'], entityType: 'personal' },
  { name: 'update_personal', description: 'Update a PerPersonal record (OData MERGE by composite key).', inputSchema: idSchema('Full OData key predicate for PerPersonal.'), categories: ['write'], entityType: 'personal' },
  { name: 'create_employee_time', description: 'Upsert an EmployeeTime (time off) record (OData upsert).', inputSchema: emptySchema, categories: ['write'], entityType: 'time' },
  { name: 'update_employee_time', description: 'Update an EmployeeTime record (OData MERGE by key).', inputSchema: idSchema('EmployeeTime external code / key predicate.'), categories: ['write'], entityType: 'time' },
  // Employer benefit contributions per employee for savings & pension plans (Global
  // Benefits OData: EmployeeWithEmployerMatchContributions + the pension/savings ER
  // contribution entities). The client queries + flattens them per employee.
  // useListMethod → client.list(). Retirement/savings only (insurance is rate-chart config).
  { name: 'list_employer_match_contributions', description: 'List SuccessFactors per-employee employer benefit contributions for savings/pension plans (Global Benefits EmployeeWithEmployerMatchContributions + ER contribution entities).', inputSchema: emptySchema, categories: ['read'], entityType: 'sap_employer_match', useListMethod: true },
  nativeTool('SAP SuccessFactors', 'sap_successfactors_native_request'),
];

// ── Oracle Fusion HCM ─────────────────────────────────────────────────────────
export const ORACLE_HCM_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_workers', description: 'List Oracle Fusion HCM workers (q/fields/expand/limit supported).', inputSchema: { type: 'object', properties: { q: { type: 'string' }, fields: { type: 'string' }, expand: { type: 'string' }, limit: { type: 'string' } } }, categories: ['read'], entityType: 'workers', responseSchema: listUnder('items') },
  { name: 'get_worker', description: 'Get an Oracle Fusion HCM worker by key.', inputSchema: idSchema('Worker key (PersonId/PersonNumber).'), categories: ['read'], entityType: 'worker' },
  { name: 'list_emps', description: 'List Oracle Fusion HCM emps.', inputSchema: emptySchema, categories: ['read'], entityType: 'emps' },
  { name: 'list_departments', description: 'List Oracle Fusion HCM departments.', inputSchema: emptySchema, categories: ['read'], entityType: 'departments' },
  { name: 'list_locations', description: 'List Oracle Fusion HCM locations.', inputSchema: emptySchema, categories: ['read'], entityType: 'locations' },
  { name: 'list_positions', description: 'List Oracle Fusion HCM positions.', inputSchema: emptySchema, categories: ['read'], entityType: 'positions' },
  { name: 'list_jobs', description: 'List Oracle Fusion HCM jobs.', inputSchema: emptySchema, categories: ['read'], entityType: 'jobs' },
  { name: 'list_grades', description: 'List Oracle Fusion HCM grades.', inputSchema: emptySchema, categories: ['read'], entityType: 'grades' },
  { name: 'list_payslips', description: 'List Oracle Fusion HCM payslips (per-employee pay records: PaymentDate, Amount, CurrencyCode, PersonId).', inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'string' } } }, categories: ['read'], entityType: 'payslips', responseSchema: listUnder('items') },
  { name: 'list_salaries', description: 'List Oracle Fusion HCM salaries (per-employee base pay: AnnualSalary, CurrencyCode, SalaryFrequencyCode, PersonId, DateFrom/DateTo).', inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'string' } } }, categories: ['read'], entityType: 'salaries', responseSchema: listUnder('items') },
  { name: 'create_worker', description: 'Create an Oracle Fusion HCM worker.', inputSchema: emptySchema, categories: ['write'], entityType: 'worker' },
  { name: 'update_worker', description: 'Update an Oracle Fusion HCM worker by key (PATCH).', inputSchema: idSchema('Worker key.'), categories: ['write'], entityType: 'worker' },
  // Net-pay splits + employee bank accounts: multi-request derivations (workers
  // PersonNumber→PersonId bridge; Financials externalBankAccounts). useListMethod → client.list().
  { name: 'list_net_pay_splits', description: 'List Oracle net-pay splits per employee (personalPaymentMethods grouped via the workers PersonNumber→PersonId bridge).', inputSchema: emptySchema, categories: ['read'], entityType: 'net_pay_splits', useListMethod: true },
  { name: 'list_employee_bank_accounts', description: 'List Oracle employee bank accounts (Financials externalBankAccounts, top-level PersonId).', inputSchema: emptySchema, categories: ['read'], entityType: 'employee_bank_accounts', useListMethod: true },
  { name: 'list_oracle_deductions', description: 'List Oracle post-tax deductions (elementEntries filtered to deduction classifications; amount from elementEntryValues).', inputSchema: emptySchema, categories: ['read'], entityType: 'oracle_deductions', useListMethod: true },
  // Per-employee EMPLOYER burden from the Statement of Earnings (personProcessResults
  // → SOEBalanceView, employer-charges balance group). GATED: needs the payroll-admin
  // data role (PAY_ACCESS_PAYROLL_FLOWS + PAY_VERIFY_STATEMENT_OF_EARNING); inert otherwise.
  { name: 'list_employer_charges', description: 'List Oracle per-employee employer charges (employer taxes + liabilities) from the Statement of Earnings; run-linked via personProcessResults ObjectActionId. Requires payroll-admin data role.', inputSchema: emptySchema, categories: ['read'], entityType: 'employer_charges', useListMethod: true },
  nativeTool('Oracle HCM', 'oracle_hcm_native_request'),
];

// ── Workday ───────────────────────────────────────────────────────────────────
export const WORKDAY_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_workers', description: 'List Workday workers (Common REST).', inputSchema: emptySchema, categories: ['read'], entityType: 'workers' },
  { name: 'get_worker', description: 'Get a Workday worker by id.', inputSchema: idSchema('Worker id.'), categories: ['read'], entityType: 'worker' },
  { name: 'run_wql', description: 'Run a Workday Query Language (WQL) query — the richest read surface.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'WQL query text.' } }, required: ['query'] }, categories: ['read'], entityType: 'wql' },
  { name: 'get_report', description: 'Fetch a Workday custom report (RaaS) as JSON.', inputSchema: { type: 'object', properties: { reportUrl: { type: 'string', description: 'Full RaaS report URL.' } }, required: ['reportUrl'] }, categories: ['read'], entityType: 'report' },
  { name: 'update_worker', description: 'Update a Workday worker via Common REST (where the resource is writable).', inputSchema: idSchema('Worker id.'), categories: ['write'], entityType: 'worker' },
  { name: 'submit_business_process', description: 'Submit a Workday Web Services (SOAP) business process — Change_Job, Hire, Terminate, etc. — the write path beyond Common REST.', inputSchema: { type: 'object', properties: { service: { type: 'string', description: 'WWS service, e.g. Staffing or Human_Resources.' }, operationXml: { type: 'string', description: 'Inner <wd:*_Request> operation XML.' }, version: { type: 'string', description: 'WWS version (default v43.0).' } }, required: ['operationXml'] }, categories: ['write'], entityType: 'soap' },
  // Base pay + payroll results live only on the WWS SOAP surface (not Common REST/WQL).
  // The client parses the SOAP XML and returns normalized per-worker records.
  // useListMethod routes these through the client's list() (which parses the SOAP
  // XML) instead of read() — the entityType is a bespoke sentinel, not a REST path.
  { name: 'list_worker_compensation', description: 'List Workday worker base compensation (Get_Workers with Include_Compensation, via WWS SOAP).', inputSchema: emptySchema, categories: ['read'], entityType: 'worker_compensation', useListMethod: true },
  { name: 'list_payroll_results', description: 'List Workday payroll results over the trailing period (Get_Payroll_Results, via WWS SOAP).', inputSchema: emptySchema, categories: ['read'], entityType: 'payroll_results', useListMethod: true },
  { name: 'list_federal_w4', description: 'List Workday employees\' federal W-4 tax elections (Get_Payroll_Federal_W-4_Tax_Election, via WWS SOAP ≥ v33.2).', inputSchema: emptySchema, categories: ['read'], entityType: 'federal_w4', useListMethod: true },
  { name: 'list_federal_tax_params', description: 'List Workday federal W-4 elections expanded into per-field tax-param rows (for the generic Tax Parameters widget).', inputSchema: emptySchema, categories: ['read'], entityType: 'federal_tax_params', useListMethod: true },
  { name: 'list_withholding_orders', description: 'List Workday involuntary withholding orders / garnishments (Get_Payroll_Involuntary_Withholding_Orders, via WWS SOAP).', inputSchema: emptySchema, categories: ['read'], entityType: 'withholding_orders', useListMethod: true },
  nativeTool('Workday', 'workday_native_request'),
];

// ── Batch 2 (9 providers) ─────────────────────────────────────────────────────
// Deel / Factorial / HiBob / Personio / UKG Pro / UKG Ready / Dayforce / ADP RUN /
// ADP Workforce Now. All customer-credential, zero vendor review. Every curated
// tool carries a templated entityType ("METHOD /path") dispatched through
// templated-dispatch by the vendor client.

// ── Deel ────────────────────────────────────────────────────────────────────
export const DEEL_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_people', description: 'List Deel people (workers/employees/contractors).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /people' },
  { name: 'get_person', description: 'Get a Deel person by id.', inputSchema: idSchema('Person id.'), categories: ['read'], entityType: 'GET /people/{id}' },
  { name: 'list_contracts', description: 'List Deel contracts.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /contracts' },
  { name: 'get_contract', description: 'Get a Deel contract by id.', inputSchema: idSchema('Contract id.'), categories: ['read'], entityType: 'GET /contracts/{id}' },
  { name: 'list_timesheets', description: 'List Deel timesheets.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /timesheets' },
  { name: 'submit_timesheet', description: 'Submit a Deel timesheet.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /timesheets' },
  { name: 'list_invoices', description: 'List Deel invoices.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /invoices' },
  { name: 'list_payslips', description: 'List Deel global-payroll payslips for a worker.', inputSchema: pathParamSchema('worker_id', 'Deel worker id.'), categories: ['read'], entityType: 'GET /gp/workers/{worker_id}/payslips' },
  { name: 'list_worker_compensation', description: 'List a Deel worker\'s compensation (scale=YEAR|MONTH|HOUR, salary, effective_date).', inputSchema: pathParamSchema('worker_id', 'Deel worker id.'), categories: ['read'], entityType: 'GET /gp/workers/{worker_id}/compensation' },
  { name: 'list_time_off', description: 'List Deel time-off entries.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /time_offs' },
  { name: 'create_time_off', description: 'Create a Deel time-off entry.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /time_offs' },
  // Company-level payroll runs: the client fans out legal-entities → per-entity
  // payroll-events (cycles). useListMethod routes it through the client's list().
  { name: 'list_payroll_runs', description: 'List Deel payroll runs (cycles) across all legal entities (period start/end, payday=cycle end).', inputSchema: emptySchema, categories: ['read'], entityType: 'payroll_runs', useListMethod: true },
  // Per-contractor payments (→ hris company_contractor_payments). The client lists
  // GET /payments and flattens any inline per-contractor breakdown into per-worker rows.
  { name: 'list_contractor_payments', description: 'List Deel per-contractor payments (worker id, amount, currency, pay date, payment method) from GET /payments.', inputSchema: emptySchema, categories: ['read'], entityType: 'contractor_payments', useListMethod: true },
  { name: 'list_deel_employer_charges', description: 'List Deel per-employee EMPLOYER taxes + contributions (Global Payroll) from the committed gross-to-net cycle report; run link = cycle id.', inputSchema: emptySchema, categories: ['read'], entityType: 'employer_charges', useListMethod: true },
  nativeTool('Deel', 'deel_native_request'),
];

// ── Factorial ─────────────────────────────────────────────────────────────────
export const FACTORIAL_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_employees', description: 'List Factorial employees.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /resources/employees/employees' },
  { name: 'get_employee', description: 'Get a Factorial employee by id.', inputSchema: idSchema('Employee id.'), categories: ['read'], entityType: 'GET /resources/employees/employees/{id}' },
  { name: 'update_employee', description: 'Update a Factorial employee by id.', inputSchema: idSchema('Employee id.'), categories: ['write'], entityType: 'PUT /resources/employees/employees/{id}' },
  { name: 'list_contracts', description: 'List Factorial contract versions.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /resources/contracts/contract_versions' },
  { name: 'list_leaves', description: 'List Factorial time-off leaves.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /resources/timeoff/leaves' },
  { name: 'create_leave', description: 'Create a Factorial time-off leave.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /resources/timeoff/leaves' },
  { name: 'list_teams', description: 'List Factorial teams.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /resources/teams/teams' },
  { name: 'list_attendance', description: 'List Factorial attendance shifts.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /resources/attendance/shifts' },
  // Recurring reimbursements: contracts/compensations bridged to employees via
  // contract_versions. useListMethod → client.list() (multi-request derivation).
  { name: 'list_recurring_reimbursements', description: 'List Factorial recurring reimbursements/supplements (contracts/compensations, recurring only, employee-linked via contract_versions).', inputSchema: emptySchema, categories: ['read'], entityType: 'recurring_reimbursements', useListMethod: true },
  // Employer benefit contributions per employee: supplements/compensations classified to
  // the company_contribution concept category (employee-linked via contract_versions).
  // useListMethod → client.list() (multi-request derivation, mirrors recurring_reimbursements).
  { name: 'list_company_contributions', description: 'List Factorial per-employee employer benefit contributions (supplements/compensations in the company_contribution concept category, employee-linked via contract_versions).', inputSchema: emptySchema, categories: ['read'], entityType: 'factorial_company_contributions', useListMethod: true },
  nativeTool('Factorial', 'factorial_native_request'),
];

// ── HiBob ─────────────────────────────────────────────────────────────────────
export const HIBOB_FUNCTIONS: ConnectorFunction[] = [
  // HiBob reads are POST-based (per apidocs.hibob.com people-read-api-contract):
  // POST /people/search returns the full result set; POST /people/{identifier}
  // reads one employee by id or email.
  { name: 'list_people', description: 'Search/list HiBob people (returns the full result set; optional filters/fields in the body).', inputSchema: emptySchema, categories: ['read'], entityType: 'POST /people/search', responseSchema: listUnder('employees') },
  { name: 'get_person', description: 'Read a single HiBob person by id or email.', inputSchema: pathParamSchema('identifier', 'Employee id or email.'), categories: ['read'], entityType: 'POST /people/{identifier}' },
  { name: 'update_person', description: 'Update a HiBob person by id.', inputSchema: pathParamSchema('identifier', 'Employee id.'), categories: ['write'], entityType: 'PUT /people/{identifier}' },
  { name: 'list_time_off_requests', description: 'List HiBob time-off requests.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /timeoff/requests' },
  { name: 'submit_time_off', description: 'Submit a HiBob time-off request for an employee.', inputSchema: idSchema('Employee id.'), categories: ['write'], entityType: 'POST /timeoff/employees/{id}/requests' },
  { name: 'list_payroll', description: 'List HiBob payroll history.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /payroll/history' },
  { name: 'list_salaries', description: 'List a HiBob person\'s salary history (values[].base.{value,currency}, payPeriod).', inputSchema: idSchema('Employee id.'), categories: ['read'], entityType: 'GET /people/{id}/salaries', responseSchema: listUnder('values') },
  { name: 'list_lists', description: 'List HiBob company named lists.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /company/named-lists' },
  nativeTool('HiBob', 'hibob_native_request'),
];

// ── Personio ────────────────────────────────────────────────────────────────
export const PERSONIO_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_employees', description: 'List Personio employees.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /company/employees' },
  { name: 'get_employee', description: 'Get a Personio employee by id.', inputSchema: idSchema('Employee id.'), categories: ['read'], entityType: 'GET /company/employees/{id}' },
  { name: 'update_employee', description: 'Update a Personio employee by id.', inputSchema: idSchema('Employee id.'), categories: ['write'], entityType: 'PATCH /company/employees/{id}' },
  { name: 'list_attendances', description: 'List Personio attendances.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /company/attendances' },
  { name: 'create_attendance', description: 'Create a Personio attendance period.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /company/attendances' },
  { name: 'list_absences', description: 'List Personio absences (time-offs).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /company/time-offs' },
  { name: 'create_absence', description: 'Create a Personio absence (time-off).', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /company/time-offs' },
  { name: 'list_absence_types', description: 'List Personio absence (time-off) types.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /company/time-off-types' },
  nativeTool('Personio', 'personio_native_request'),
];

// ── UKG Pro ───────────────────────────────────────────────────────────────────
export const UKG_PRO_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_employees', description: 'List UKG Pro employees.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /personnel/v1/employees' },
  { name: 'get_employee', description: 'Get a UKG Pro employee by id.', inputSchema: idSchema('Employee id.'), categories: ['read'], entityType: 'GET /personnel/v1/employees/{id}' },
  { name: 'list_employment', description: 'List UKG Pro employment details.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /personnel/v1/employment-details' },
  { name: 'list_compensation', description: 'List UKG Pro compensation details (financial).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /personnel/v1/compensation-details' },
  // Per-employee pay statements: POST /payroll/v1/employees/pay-statements (employee
  // identifier + date range). The client handles the POST-read + normalization.
  { name: 'list_pay_statements', description: 'List UKG Pro pay statements for an employee (POST /payroll/v1/employees/pay-statements).', inputSchema: pathParamSchema('id', 'Employee id.'), categories: ['read'], entityType: 'employee_pay_statements' },
  { name: 'list_ukg_pro_payrolls', description: 'List UKG Pro payroll runs (pay-group pay periods; GET /payroll/v1/paygroup-payperiods) — the run each pay statement links to via payGroup:payDate.', inputSchema: emptySchema, categories: ['read'], entityType: 'ukg_pro_payrolls', useListMethod: true },
  // Benefit deductions: per employee/deduction-code employer (employerAmount) + employee
  // (employeeAmount) contribution amounts (GET /personnel/v1/emp-deductions). The client
  // flattens the per-employee deduction rows. useListMethod → client.list().
  { name: 'list_employee_deductions', description: 'List UKG Pro per-employee benefit deductions with employer (employerAmount) + employee (employeeAmount) contribution amounts (GET /personnel/v1/emp-deductions).', inputSchema: emptySchema, categories: ['read'], entityType: 'ukg_pro_emp_deductions', useListMethod: true },
  { name: 'list_time_off_plans', description: 'List UKG Pro time-off plans.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /time/v1/time-off-plans' },
  nativeTool('UKG Pro', 'ukg_pro_native_request'),
];

// ── UKG Ready ─────────────────────────────────────────────────────────────────
export const UKG_READY_FUNCTIONS: ConnectorFunction[] = [
  { name: 'list_employees', description: 'List UKG Ready employees for the connected company.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /companies/{cid}/employees' },
  { name: 'get_employee', description: 'Get a UKG Ready employee by id.', inputSchema: idSchema('Employee id.'), categories: ['read'], entityType: 'GET /employees/{id}' },
  { name: 'update_employee', description: 'Update a UKG Ready employee by id.', inputSchema: idSchema('Employee id.'), categories: ['write'], entityType: 'PUT /employees/{id}' },
  { name: 'list_timesheets', description: 'List UKG Ready timesheets.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /timesheets' },
  { name: 'list_accruals', description: 'List UKG Ready accruals.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /accruals' },
  // Per-employee pay statements (employee-parented; {cid} from companyShortName, {id}
  // from the employee fan-out). SaaShr REST is snake_case (cf. compensation/history).
  { name: 'list_employee_pay_statements', description: 'List UKG Ready pay statements for an employee.', inputSchema: pathParamSchema('id', 'Employee id.'), categories: ['read'], entityType: 'GET /companies/{cid}/employees/{id}/payroll/pay-statements' },
  // Company payrolls (the run a pay statement links to). SaaShr nests pay statements
  // under a payroll (the by-payroll pay-statement endpoints take a payroll id path param).
  { name: 'list_payrolls', description: 'List UKG Ready company payrolls (the payroll runs pay statements belong to).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /companies/{cid}/payrolls' },
  { name: 'list_compensation_history', description: 'List UKG Ready base compensation history (compensations[].{amount,amount_period,currency,effective_from,employee.account_id}).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /companies/{cid}/compensation/history' },
  nativeTool('UKG Ready', 'ukg_ready_native_request'),
];

// ── Dayforce ──────────────────────────────────────────────────────────────────
// Curated first-class tools hand-authored from the public Dayforce RESTful Web
// Services Developer Guide (help.dayforce.com). Every entityType is an operation
// template routed through templated-dispatch; base is the client's
// .../Api/{companyId}/V1 so paths omit /V1. DELETE is supported by the dispatch
// (templatedDelete) + the client's delete(). The dayforce_native_request
// passthrough still reaches any endpoint not curated here.
export const DAYFORCE_FUNCTIONS: ConnectorFunction[] = [
  // Employees
  { name: 'list_employees', description: 'List Dayforce employees.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /Employees', responseSchema: listUnder('Data') },
  // Full employee HR details — bulk GET /Employees returns only XRefCodes, so this fans out
  // GET /Employees/{xref}?expand=Addresses,MaritalStatuses,Contacts per employee (client.listEmployeesFull).
  { name: 'list_employees_full', description: 'List Dayforce employees with full HR details (name, gender, phone, residence address, marital status) via per-employee expand fan-out.', inputSchema: emptySchema, categories: ['read'], entityType: 'dayforce_employees_full', useListMethod: true },
  { name: 'get_employee', description: 'Get a Dayforce employee by XRefCode.', inputSchema: pathParamSchema('xrefCode', 'Employee XRefCode.'), categories: ['read'], entityType: 'GET /Employees/{xrefCode}' },
  { name: 'create_employee', description: 'Create a Dayforce employee (hire).', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /Employees' },
  { name: 'update_employee', description: 'Update a Dayforce employee by XRefCode.', inputSchema: pathParamSchema('xrefCode', 'Employee XRefCode.'), categories: ['write'], entityType: 'PATCH /Employees/{xrefCode}' },
  { name: 'get_employee_work_assignments', description: 'Get a Dayforce employee’s work assignments (position/location).', inputSchema: pathParamSchema('xrefCode', 'Employee XRefCode.'), categories: ['read'], entityType: 'GET /Employees/{xrefCode}/WorkAssignments' },
  { name: 'get_employee_compensation', description: 'Get a Dayforce employee’s compensation summary (financial).', inputSchema: pathParamSchema('xrefCode', 'Employee XRefCode.'), categories: ['read'], entityType: 'GET /Employees/{xrefCode}/CompensationSummary' },
  // Earning rate: fan out over employees + take the latest CompensationSummary row
  // per employee (client.listEarningRates). useListMethod → client.list('dayforce_earning_rates').
  { name: 'list_dayforce_earning_rates', description: 'List current earning rates per Dayforce employee (latest CompensationSummary change; BaseSalary annual / BaseRate hourly).', inputSchema: emptySchema, categories: ['read'], entityType: 'dayforce_earning_rates', useListMethod: true },
  { name: 'get_employee_dependents', description: 'Get a Dayforce employee’s dependents and beneficiaries.', inputSchema: pathParamSchema('xrefCode', 'Employee XRefCode.'), categories: ['read'], entityType: 'GET /Employees/{xrefCode}/DependentsBeneficiaries' },
  { name: 'get_employee_time_away', description: 'Get a Dayforce employee’s time-away-from-work records.', inputSchema: pathParamSchema('xrefCode', 'Employee XRefCode.'), categories: ['read'], entityType: 'GET /Employees/{xrefCode}/TimeAwayFromWork' },
  // Pay & compensation (financial)
  { name: 'list_pay_summaries', description: 'List Dayforce per-employee per-pay-date payment totals (Σ PayAmount aggregated from EmployeePaySummaries WFM lines).', inputSchema: emptySchema, categories: ['read'], entityType: 'pay_summaries', useListMethod: true },
  { name: 'list_committed_pay_run', description: 'List Dayforce per-employee EMPLOYER taxes + contributions from a Committed Pay Run Results report (Reporting API; requires connectorConfig.committedPayRunReportXRefCode).', inputSchema: emptySchema, categories: ['read'], entityType: 'committed_pay_run', useListMethod: true },
  { name: 'list_pay', description: 'List Dayforce employee pay adjustments (financial).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /EmployeePayAdjustments' },
  { name: 'create_pay_adjustment', description: 'Create a Dayforce employee pay adjustment (financial).', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /EmployeePayAdjustments' },
  { name: 'update_pay_adjustment', description: 'Update a Dayforce employee pay adjustment (financial).', inputSchema: emptySchema, categories: ['write'], entityType: 'PATCH /EmployeePayAdjustments' },
  { name: 'list_job_step_rates', description: 'List Dayforce job step (pay) rates (financial).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /JobStepRates' },
  { name: 'list_retro_pay', description: 'List Dayforce employee retro-pay data (financial).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /EmployeeRetroData' },
  // Time & attendance
  { name: 'list_schedules', description: 'List Dayforce employee schedules.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /EmployeeSchedules' },
  { name: 'create_schedule', description: 'Create a Dayforce employee schedule.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /EmployeeSchedules' },
  { name: 'update_schedule', description: 'Update a Dayforce employee schedule.', inputSchema: emptySchema, categories: ['write'], entityType: 'PATCH /EmployeeSchedules' },
  { name: 'list_punches', description: 'List Dayforce employee punches (time clock).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /EmployeePunches' },
  { name: 'create_punch', description: 'Create a Dayforce employee punch.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /EmployeePunches' },
  { name: 'update_punch', description: 'Update a Dayforce employee punch.', inputSchema: emptySchema, categories: ['write'], entityType: 'PATCH /EmployeePunches' },
  { name: 'delete_punch', description: 'Delete a Dayforce employee punch.', inputSchema: emptySchema, categories: ['destructive'], entityType: 'DELETE /EmployeePunches' },
  { name: 'submit_availability', description: 'Submit Dayforce employee availability.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /Availability' },
  // Balances & leave
  { name: 'list_balance_periods', description: 'List Dayforce employee balance periods (accruals).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /EmployeeBalancePeriods' },
  { name: 'list_balance_transactions', description: 'List Dayforce employee balance transactions.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /EmployeeBalanceTransactions' },
  { name: 'create_balance_transaction', description: 'Create a Dayforce employee balance transaction.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /EmployeeBalanceTransactions' },
  { name: 'update_balance_transaction', description: 'Update a Dayforce employee balance transaction.', inputSchema: emptySchema, categories: ['write'], entityType: 'PATCH /EmployeeBalanceTransactions' },
  // Org structure
  { name: 'list_orgunits', description: 'List Dayforce org units.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /OrgUnits' },
  { name: 'get_orgunit', description: 'Get a Dayforce org unit by XRefCode.', inputSchema: pathParamSchema('xrefCode', 'Org unit XRefCode.'), categories: ['read'], entityType: 'GET /OrgUnits/{xrefCode}' },
  { name: 'create_orgunit', description: 'Create a Dayforce org unit.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /OrgUnits' },
  { name: 'update_orgunit', description: 'Update a Dayforce org unit.', inputSchema: emptySchema, categories: ['write'], entityType: 'PATCH /OrgUnits' },
  { name: 'list_departments', description: 'List Dayforce departments.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /Departments' },
  { name: 'get_department', description: 'Get a Dayforce department by XRefCode.', inputSchema: pathParamSchema('xrefCode', 'Department XRefCode.'), categories: ['read'], entityType: 'GET /Departments/{xrefCode}' },
  // Jobs & positions
  { name: 'list_jobs', description: 'List Dayforce jobs.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /Jobs' },
  { name: 'get_job', description: 'Get a Dayforce job by XRefCode.', inputSchema: pathParamSchema('xrefCode', 'Job XRefCode.'), categories: ['read'], entityType: 'GET /Jobs/{xrefCode}' },
  { name: 'create_job', description: 'Create a Dayforce job.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /Jobs' },
  { name: 'update_job', description: 'Update a Dayforce job.', inputSchema: emptySchema, categories: ['write'], entityType: 'PATCH /Jobs' },
  { name: 'list_positions', description: 'List Dayforce positions.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /Positions' },
  { name: 'get_position', description: 'Get a Dayforce position by XRefCode.', inputSchema: pathParamSchema('xrefCode', 'Position XRefCode.'), categories: ['read'], entityType: 'GET /Positions/{xrefCode}' },
  // Labor metrics, projects, documents, reports
  { name: 'list_labor_metrics', description: 'List Dayforce labor metrics.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /LaborMetrics' },
  { name: 'list_projects', description: 'List Dayforce projects.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /Projects' },
  { name: 'list_documents', description: 'List Dayforce documents.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /Documents' },
  { name: 'get_report', description: 'Run/get a Dayforce report by id (RaaS).', inputSchema: pathParamSchema('reportId', 'Report XRefCode/id.'), categories: ['read'], entityType: 'GET /Reports/{reportId}' },
  nativeTool('Dayforce', 'dayforce_native_request'),
];

// ── ADP RUN + ADP Workforce Now (shared curated set; one AdpClient) ────────────
function adpFunctions(nativeToolName: string): ConnectorFunction[] {
  return [
    { name: 'list_workers', description: 'List ADP workers.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /hr/v2/workers', responseSchema: listUnder('workers') },
    { name: 'get_worker', description: 'Get an ADP worker by associate OID.', inputSchema: pathParamSchema('aoid', 'Associate OID (AOID).'), categories: ['read'], entityType: 'GET /hr/v2/workers/{aoid}' },
    { name: 'list_pay_statements', description: 'List ADP pay statements for a worker.', inputSchema: pathParamSchema('aoid', 'Associate OID (AOID).'), categories: ['read'], entityType: 'GET /payroll/v1/workers/{aoid}/pay-statements' },
    // Per-associate EMPLOYER burden from the ADP Payroll Output (Turbo) API. GATED:
    // needs the Payroll Output scope/entitlement (separate from HR/pay-statement); inert otherwise.
    { name: 'list_payroll_output', description: 'List ADP per-associate payroll output (employer taxes + employer benefits, run-linked). Requires the Payroll Output API entitlement.', inputSchema: emptySchema, categories: ['read'], entityType: 'payroll_output', useListMethod: true },
    { name: 'submit_pay_data_input', description: 'Submit an ADP pay data input event (financial).', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /events/payroll/v1/pay-data-input.add' },
    { name: 'list_org', description: 'List ADP organization departments.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /core/v1/organization-departments' },
    nativeTool('ADP', nativeToolName),
  ];
}
export const ADP_WORKFORCE_NOW_FUNCTIONS: ConnectorFunction[] = adpFunctions('adp_workforce_now_native_request');
export const ADP_RUN_FUNCTIONS: ConnectorFunction[] = adpFunctions('adp_run_native_request');

// ── BambooHR (developer-portal OAuth app; full generated surface + curated core) ─
// Curated first-class tools (hand-authored names/descriptions/schemas) for the most
// common operations; every name + templated entityType matches a tool in the
// generated set (openapi 3.1, 293 endpoints), so mergeTools cleanly overrides the
// auto-generated definition with the friendlier curated one. The exhaustive long tail
// (payroll, scheduling, performance, recognitions, onboarding, …) comes from the
// generated set; anything not curated is still reachable via the passthrough.
export const BAMBOOHR_FUNCTIONS: ConnectorFunction[] = [
  // Employees
  { name: 'get_employee', description: 'Get a BambooHR employee by id (use id="0" for the API key owner). Pass fields="firstName,lastName,workEmail,jobTitle,department,…" to select fields.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Employee id (or "0" for the authenticated user).' }, fields: { type: 'string', description: 'Comma-separated field list to return.' } }, required: ['id'] }, categories: ['read'], entityType: 'GET /api/v1/employees/{id}' },
  { name: 'get_employees_directory', description: 'Get the full BambooHR company employee directory (all active employees + field definitions).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /api/v1/employees/directory' },
  // Full per-employee profile for EVERY employee in ONE call, via the custom-report API
  // (POST /api/v1/reports/custom) — the directory returns only a thin subset, so this is the
  // source for the complete canonical field set (contact, personal, address, dates, job, pay).
  { name: 'get_employees_full', description: 'Get all BambooHR employees with the full profile field set (custom report — one call: contact, personal, address, hire/termination dates, job, pay, manager).', inputSchema: emptySchema, categories: ['read'], entityType: 'employees_full', useListMethod: true },
  { name: 'get_employee_table_data', description: 'Get rows from a BambooHR employee table (e.g. jobInfo, compensation, employmentStatus).', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Employee id.' }, table: { type: 'string', description: 'Table name, e.g. jobInfo, compensation, employmentStatus.' } }, required: ['id', 'table'] }, categories: ['read'], entityType: 'GET /api/v1/employees/{id}/tables/{table}' },
  // Per-employee current base pay: the client reads /tables/compensation and returns
  // only the latest row (bespoke entityType, not a templated path — see BambooHRClient.read).
  { name: 'get_employee_compensation', description: 'Get a BambooHR employee\'s current base compensation (latest row of the compensation table).', inputSchema: pathParamSchema('id', 'Employee id.'), categories: ['read'], entityType: 'employee_compensation_current' },
  // Time off
  { name: 'list_time_off_requests', description: 'List BambooHR time-off requests (optional start/end/status/employeeId/type filters).', inputSchema: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, status: { type: 'string' }, employeeId: { type: 'string' }, type: { type: 'string' } } }, categories: ['read'], entityType: 'GET /api/v1/time_off/requests' },
  { name: 'create_time_off_request', description: 'Submit a BambooHR time-off request for an employee.', inputSchema: { type: 'object', properties: { employeeId: { type: 'string', description: 'Employee id.' }, timeOffTypeId: { type: 'number' }, start: { type: 'string', description: 'YYYY-MM-DD.' }, end: { type: 'string', description: 'YYYY-MM-DD.' }, note: { type: 'string' } }, required: ['employeeId'] }, categories: ['write'], entityType: 'PUT /api/v1/employees/{employeeId}/time_off/request' },
  { name: 'update_time_off_request_status', description: 'Approve, deny, or cancel a BambooHR time-off request (status = approved | denied | cancelled).', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Time-off request id.' }, status: { type: 'string', description: 'approved | denied | cancelled.' }, note: { type: 'string' } }, required: ['id', 'status'] }, categories: ['write'], entityType: 'PUT /api/v1/time_off/requests/{id}/status' },
  { name: 'list_whos_out', description: "List who's out of office from the BambooHR time-off calendar for a date range.", inputSchema: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } } }, categories: ['read'], entityType: 'GET /api/v1/time_off/whos_out' },
  { name: 'list_time_off_types', description: 'List BambooHR time-off types.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /api/v1/meta/time_off/types' },
  // Reports / datasets (workforce analytics)
  { name: 'list_reports', description: 'List BambooHR custom reports.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /api/v1/custom-reports' },
  { name: 'get_report_by_id', description: 'Fetch a BambooHR custom report by id.', inputSchema: pathParamSchema('reportId', 'Report id.'), categories: ['read'], entityType: 'GET /api/v1/custom-reports/{reportId}' },
  { name: 'list_datasets_v1', description: 'List BambooHR datasets (workforce analytics data sources).', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /api/v1/datasets' },
  // Meta
  { name: 'list_fields', description: 'List BambooHR field definitions.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /api/v1/meta/fields' },
  { name: 'list_tabular_fields', description: 'List BambooHR tabular (table) field definitions.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /api/v1/meta/tables' },
  { name: 'list_users', description: 'List BambooHR users.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /api/v1/meta/users' },
  // Benefits — per-employee benefit enrollments carrying the employer-paid contribution
  // (companyAmount) alongside the employee deduction (employeeAmount). The client reads
  // POST /api/v1/benefit/employee_benefit and flattens employeeBenefits[].employeeBenefit[]
  // into per-(employee, plan) rows. Closes fully-loaded cost. useListMethod → client.list().
  { name: 'list_employee_benefits', description: 'List BambooHR per-employee benefit enrollments with employer (companyAmount) + employee (employeeAmount) contribution amounts, flattened per employee/plan.', inputSchema: emptySchema, categories: ['read'], entityType: 'employee_benefits', useListMethod: true },
  { name: 'list_company_benefits', description: 'List the benefit plans the BambooHR company offers (GET /api/v1/benefit/company_benefit).', inputSchema: emptySchema, categories: ['read'], entityType: 'company_benefits', useListMethod: true },
  nativeTool('BambooHR', 'bamboohr_native_request'),
];

// Dedupe by tool name (curated core wins — version-aware updates, pagination;
// the generated set fills the full long tail).
function mergeTools(...sets: ConnectorFunction[][]): ConnectorFunction[] {
  const seen = new Set<string>();
  const out: ConnectorFunction[] = [];
  for (const set of sets) for (const fn of set) if (!seen.has(fn.name)) { seen.add(fn.name); out.push(fn); }
  return out;
}

/** Convenience map — the dormant native function set per connector type.
 *  Gusto (App Integrations) and Namely are the full generated surface merged
 *  with the curated core. Rippling/SAP/Oracle stay curated-core + passthrough
 *  until their specs are run through `npm run gen:connector-tools` (their specs
 *  aren't in the public openapi-examples repo — need portal/partner access);
 *  Workday likewise pending its per-module base wiring. */
// ── Warp (api.joinwarp.com; OpenAPI at /docs/openapi.json) ───────────────────
// Native api_key (x-api-key header). All 34 published operations mapped as tools.
// List tools that feed the HRIS sync use useListMethod + a synthetic entityType
// (warp_*) routed by WarpClient.list() (cursor pagination). The rest carry the
// templated "METHOD /v1/path" entityType routed via templated-dispatch.
export const WARP_FUNCTIONS: ConnectorFunction[] = [
  // Workers
  { name: 'list_workers', description: 'List all Warp workers (employees + contractors).', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_workers', useListMethod: true, responseSchema: listUnder('data') },
  { name: 'list_employees', description: 'List Warp employees (workers with type=employee).', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_employees', useListMethod: true, responseSchema: listUnder('data') },
  { name: 'list_contractors', description: 'List Warp contractors (workers with type=contractor).', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_contractors', useListMethod: true, responseSchema: listUnder('data') },
  { name: 'get_worker', description: 'Get a Warp worker by id.', inputSchema: pathParamSchema('id', 'Worker id.'), categories: ['read'], entityType: 'GET /v1/workers/{id}' },
  { name: 'create_employee', description: 'Create a Warp employee.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /v1/workers/employee' },
  { name: 'create_contractor', description: 'Create a Warp contractor.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /v1/workers/contractor' },
  { name: 'invite_worker', description: 'Invite a Warp worker to onboard.', inputSchema: pathParamSchema('id', 'Worker id.'), categories: ['write'], entityType: 'POST /v1/workers/{id}/invite' },
  { name: 'delete_worker', description: 'Delete a Warp worker.', inputSchema: pathParamSchema('id', 'Worker id.'), categories: ['write'], entityType: 'DELETE /v1/workers/{id}' },
  // Departments
  { name: 'list_departments', description: 'List Warp departments.', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_departments', useListMethod: true, responseSchema: listUnder('data') },
  { name: 'create_department', description: 'Create a Warp department.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /v1/departments' },
  { name: 'update_department', description: 'Update a Warp department.', inputSchema: pathParamSchema('id', 'Department id.'), categories: ['write'], entityType: 'PATCH /v1/departments/{id}' },
  // Workplaces
  { name: 'list_workplaces', description: 'List Warp workplaces (remote/office locations).', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_workplaces', useListMethod: true, responseSchema: listUnder('data') },
  { name: 'create_workplace', description: 'Create a Warp workplace.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /v1/workplaces' },
  { name: 'update_workplace', description: 'Update a Warp workplace.', inputSchema: pathParamSchema('id', 'Workplace id.'), categories: ['write'], entityType: 'PATCH /v1/workplaces/{id}' },
  // Time off (read-only)
  { name: 'list_time_off_policies', description: 'List Warp time-off policies.', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_time_off_policies', useListMethod: true, responseSchema: listUnder('data') },
  { name: 'get_time_off_policy', description: 'Get a Warp time-off policy by id.', inputSchema: pathParamSchema('id', 'Time-off policy id.'), categories: ['read'], entityType: 'GET /v1/time_off/policies/{id}' },
  { name: 'list_time_off_balances', description: 'List Warp per-worker time-off balances.', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_time_off_balances', useListMethod: true, responseSchema: listUnder('data') },
  { name: 'list_time_off_requests', description: 'List Warp time-off requests.', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_time_off_requests', useListMethod: true, responseSchema: listUnder('data') },
  { name: 'list_time_off_assignments', description: 'List Warp time-off policy assignments (worker↔policy).', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_time_off_assignments', useListMethod: true, responseSchema: listUnder('data') },
  // Offers
  { name: 'list_offers', description: 'List Warp offers.', inputSchema: emptySchema, categories: ['read'], entityType: 'GET /v1/offers', responseSchema: listUnder('data') },
  { name: 'create_offer', description: 'Create a Warp offer.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /v1/offers' },
  { name: 'extend_offer_deadline', description: 'Extend a Warp offer deadline.', inputSchema: pathParamSchema('id', 'Offer id.'), categories: ['write'], entityType: 'POST /v1/offers/{id}/extend-deadline' },
  { name: 'resend_offer', description: 'Resend a Warp offer.', inputSchema: pathParamSchema('id', 'Offer id.'), categories: ['write'], entityType: 'POST /v1/offers/{id}/resend' },
  { name: 'void_offer', description: 'Void a Warp offer.', inputSchema: pathParamSchema('id', 'Offer id.'), categories: ['write'], entityType: 'POST /v1/offers/{id}/void' },
  // Custom worker fields (definitions, options, values)
  { name: 'list_custom_worker_fields', description: 'List Warp custom worker field definitions.', inputSchema: emptySchema, categories: ['read'], entityType: 'warp_custom_worker_fields', useListMethod: true, responseSchema: { type: 'array', items: { type: 'object', properties: {} } } },
  { name: 'get_custom_worker_field', description: 'Get a Warp custom worker field by id.', inputSchema: pathParamSchema('id', 'Custom worker field id.'), categories: ['read'], entityType: 'GET /v1/custom-worker-fields/{id}' },
  { name: 'create_custom_worker_field', description: 'Create a Warp custom worker field.', inputSchema: emptySchema, categories: ['write'], entityType: 'POST /v1/custom-worker-fields' },
  { name: 'update_custom_worker_field', description: 'Update a Warp custom worker field.', inputSchema: pathParamSchema('id', 'Custom worker field id.'), categories: ['write'], entityType: 'PATCH /v1/custom-worker-fields/{id}' },
  { name: 'archive_custom_worker_field', description: 'Archive a Warp custom worker field.', inputSchema: pathParamSchema('id', 'Custom worker field id.'), categories: ['write'], entityType: 'POST /v1/custom-worker-fields/{id}/archive' },
  { name: 'create_custom_worker_field_option', description: 'Create an option on a Warp select/multi_select custom field.', inputSchema: pathParamSchema('id', 'Custom worker field id.'), categories: ['write'], entityType: 'POST /v1/custom-worker-fields/{id}/options' },
  { name: 'update_custom_worker_field_option', description: 'Update a Warp custom field option.', inputSchema: pathParamSchema('id', 'Custom field option id.'), categories: ['write'], entityType: 'PATCH /v1/custom-worker-field-options/{id}' },
  { name: 'archive_custom_worker_field_option', description: 'Archive a Warp custom field option.', inputSchema: pathParamSchema('id', 'Custom field option id.'), categories: ['write'], entityType: 'POST /v1/custom-worker-field-options/{id}/archive' },
  { name: 'delete_custom_worker_field_option', description: 'Delete an unused Warp custom field option.', inputSchema: pathParamSchema('id', 'Custom field option id.'), categories: ['write'], entityType: 'DELETE /v1/custom-worker-field-options/{id}' },
  { name: 'list_worker_custom_field_values', description: 'List Warp per-worker custom field values (PII/compensation/banking live here).', inputSchema: emptySchema, categories: ['read', 'sensitive'], entityType: 'warp_custom_field_values', useListMethod: true, responseSchema: { type: 'array', items: { type: 'object', properties: {} } } },
  { name: 'set_worker_custom_field_value', description: 'Set (upsert) a Warp worker custom field value.', inputSchema: emptySchema, categories: ['write'], entityType: 'PUT /v1/worker-custom-field-values' },
  { name: 'clear_worker_custom_field_value', description: 'Clear a Warp worker custom field value.', inputSchema: emptySchema, categories: ['write'], entityType: 'DELETE /v1/worker-custom-field-values' },
  // Raw passthrough (fail-secure HITL escape hatch)
  { name: 'warp_native_request', description: 'Raw Warp API request: { method, path, body, query }.', inputSchema: emptySchema, categories: ['write'], entityType: 'native' },
];

export const NATIVE_HRIS_FUNCTIONS: Record<string, ConnectorFunction[]> = {
  warp: WARP_FUNCTIONS,
  gusto: mergeTools(GUSTO_FUNCTIONS, loadGenerated('gusto')),
  rippling: mergeTools(RIPPLING_FUNCTIONS, loadGenerated('rippling')),
  namely: mergeTools(NAMELY_FUNCTIONS, loadGenerated('namely')),
  sap_successfactors: mergeTools(SAP_SUCCESSFACTORS_FUNCTIONS, loadGenerated('sap_successfactors')),
  oracle_hcm: mergeTools(ORACLE_HCM_FUNCTIONS, loadGenerated('oracle_hcm')),
  workday: mergeTools(WORKDAY_FUNCTIONS, loadGenerated('workday_person'), loadGenerated('workday_staffing'), loadGenerated('workday_performance'), loadGenerated('workday_wws')),
  // ── Batch 2 (9) ──────────────────────────────────────────────────────────
  // Every vendor ships curated core + {vendor}_native_request passthrough.
  // deel/factorial/personio also carry their FULL generated surface (their
  // vendors publish a fetchable OpenAPI: personio → github.com/personio/api-docs,
  // factorial → api.factorialhr.com/oas, deel → api-evangelist platform spec).
  // hibob (per-endpoint .md only, no single spec), ukg_pro (portal-gated) and
  // adp RUN/WFN (Postman-only) publish no fetchable single OpenAPI → curated +
  // passthrough (their curated endpoints + auth are verified against live docs).
  // dayforce: no fetchable single OpenAPI, but the public Dayforce RESTful WS
  // Developer Guide enumerates concrete endpoints → ~40 curated first-class tools
  // (employees/pay/time/balances/org/jobs/positions/docs) + passthrough.
  // ukg_ready: login-gated docs publish NO enumerable endpoint paths → curated
  // core + passthrough only (fabricating paths would ship broken tools); auth is
  // verified from public docs. Same honest ceiling as Rippling/SAP/Oracle above.
  deel: mergeTools(DEEL_FUNCTIONS, loadGenerated('deel')),
  factorial: mergeTools(FACTORIAL_FUNCTIONS, loadGenerated('factorial')),
  hibob: HIBOB_FUNCTIONS,
  personio: mergeTools(PERSONIO_FUNCTIONS, loadGenerated('personio')),
  ukg_pro: UKG_PRO_FUNCTIONS,
  ukg_ready: UKG_READY_FUNCTIONS,
  dayforce: DAYFORCE_FUNCTIONS,
  adp_workforce_now: ADP_WORKFORCE_NOW_FUNCTIONS,
  adp_run: ADP_RUN_FUNCTIONS,
  // BambooHR: curated core + FULL generated surface (293 endpoints from the public
  // OpenAPI 3.1 spec) + passthrough.
  bamboohr: mergeTools(BAMBOOHR_FUNCTIONS, loadGenerated('bamboohr')),
};
