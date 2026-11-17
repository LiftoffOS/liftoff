-- Full payroll, benefits, and tax schema
-- Extends existing tables (company_payroll_settings, company_employees, company_contractors)
-- with additional columns and creates all remaining tables for Check HQ integration.
--
-- Employment records are soft-archived (termination_date set, not deleted) when a person
-- switches roles — preserving payroll history, tax statements, and audit trail.

-- ===========================================
-- ALTER EXISTING TABLES — add missing columns
-- ===========================================

-- company_employees: add Check HQ fields for full integration
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS ssn_last_four VARCHAR(4);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS residence_line1 VARCHAR(255);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS residence_line2 VARCHAR(255);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS residence_city VARCHAR(100);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS residence_state VARCHAR(2);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS residence_postal_code VARCHAR(10);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS workplace_id VARCHAR(255);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS primary_workplace_id VARCHAR(255);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'direct_deposit';
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS default_net_pay_split_id VARCHAR(255);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS w2_electronic_consent_provided BOOLEAN DEFAULT false;
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS onboard_blocking_steps TEXT[];
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS onboard_remaining_steps TEXT[];
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS w4_submitted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS state_forms_submitted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS termination_date DATE;
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- company_contractors: add Check HQ fields for full integration
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS ssn_last_four VARCHAR(4);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS ssn_validation_status VARCHAR(20);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS address_city VARCHAR(100);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS address_state VARCHAR(2);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS address_postal_code VARCHAR(10);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS workplace_id VARCHAR(255);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS primary_workplace_id VARCHAR(255);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'direct_deposit';
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS default_net_pay_split_id VARCHAR(255);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS onboard_blocking_steps TEXT[];
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS onboard_remaining_steps TEXT[];
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS w9_submitted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS termination_date DATE;
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- company_payroll_settings: add EIN masked field if missing
ALTER TABLE company_payroll_settings ADD COLUMN IF NOT EXISTS ein_masked VARCHAR(20);

-- ===========================================
-- COMPANY TABLES
-- ===========================================

-- Company authorized signatories
CREATE TABLE IF NOT EXISTS company_signatories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_signatory_id VARCHAR(255),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    title VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Company bank accounts
CREATE TABLE IF NOT EXISTS company_bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_bank_account_id VARCHAR(255),
    institution_name VARCHAR(255) NOT NULL,
    routing_number_masked VARCHAR(20) NOT NULL,
    account_number_masked VARCHAR(20) NOT NULL,
    account_type VARCHAR(20) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending_verification',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Company benefit plans (Check API: /company_benefits)
CREATE TABLE IF NOT EXISTS company_benefit_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_benefit_id VARCHAR(255),
    benefit_type VARCHAR(50) NOT NULL,
    description VARCHAR(255) NOT NULL,
    effective_start DATE NOT NULL,
    effective_end DATE,
    company_contribution_amount VARCHAR(50),
    company_contribution_percent NUMERIC(5,2),
    company_period_amount VARCHAR(50),
    employee_contribution_amount VARCHAR(50),
    employee_contribution_percent NUMERIC(5,2),
    employee_period_amount VARCHAR(50),
    period VARCHAR(20),
    hsa_contribution_limit VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Company payroll runs
CREATE TABLE IF NOT EXISTS company_payroll_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_payroll_id VARCHAR(255),
    payroll_type VARCHAR(20) NOT NULL DEFAULT 'regular',
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    payday DATE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    gross_pay VARCHAR(50),
    net_pay VARCHAR(50),
    employer_taxes VARCHAR(50),
    employee_taxes VARCHAR(50),
    off_cycle_force_supplemental BOOLEAN,
    off_cycle_apply_benefits BOOLEAN,
    off_cycle_apply_post_tax BOOLEAN,
    void_of_id UUID REFERENCES company_payroll_runs(id),
    voided_by_id UUID REFERENCES company_payroll_runs(id),
    void_reason TEXT,
    approved_at TIMESTAMP WITH TIME ZONE,
    approved_by UUID REFERENCES accounts(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Payroll run items (per-employee data)
CREATE TABLE IF NOT EXISTS company_payroll_run_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_run_id UUID NOT NULL REFERENCES company_payroll_runs(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES company_employees(id),
    check_item_id VARCHAR(255),
    gross_pay VARCHAR(50),
    taxes VARCHAR(50),
    deductions VARCHAR(50),
    net_pay VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Payroll run earnings (individual earning entries)
CREATE TABLE IF NOT EXISTS company_payroll_run_earnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_run_item_id UUID NOT NULL REFERENCES company_payroll_run_items(id) ON DELETE CASCADE,
    earning_type VARCHAR(50) NOT NULL,
    amount VARCHAR(50) NOT NULL,
    hours NUMERIC(10,2),
    workplace_id VARCHAR(255) NOT NULL
);

-- Contractor payments per payroll
CREATE TABLE IF NOT EXISTS company_contractor_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_run_id UUID NOT NULL REFERENCES company_payroll_runs(id) ON DELETE CASCADE,
    contractor_id UUID NOT NULL REFERENCES company_contractors(id),
    check_payment_id VARCHAR(255),
    amount VARCHAR(50) NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    reimbursement_amount VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Pay schedules
CREATE TABLE IF NOT EXISTS company_pay_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_schedule_id VARCHAR(255),
    name VARCHAR(100) NOT NULL,
    pay_frequency VARCHAR(20) NOT NULL,
    first_payday DATE NOT NULL,
    first_period_end DATE NOT NULL,
    second_period_end DATE,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Earning codes
CREATE TABLE IF NOT EXISTS company_earning_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_code_id VARCHAR(255),
    name VARCHAR(100) NOT NULL,
    earning_type VARCHAR(50) NOT NULL,
    include_in_regular_pay BOOLEAN DEFAULT true,
    taxable BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Company tax parameter settings
CREATE TABLE IF NOT EXISTS company_tax_param_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_param_id VARCHAR(255),
    jurisdiction_id VARCHAR(255) NOT NULL,
    jurisdiction_label VARCHAR(100) NOT NULL,
    param_name VARCHAR(100) NOT NULL,
    param_label VARCHAR(255) NOT NULL,
    param_type VARCHAR(50) NOT NULL,
    value VARCHAR(255),
    effective_start DATE,
    applied_for BOOLEAN DEFAULT false,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_tax_params_unique
    ON company_tax_param_settings (company_payroll_id, COALESCE(check_param_id, ''));

-- Tax filings tracking
CREATE TABLE IF NOT EXISTS company_tax_filings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_filing_id VARCHAR(255),
    year INTEGER NOT NULL,
    quarter INTEGER,
    filing_type VARCHAR(50) NOT NULL,
    jurisdiction VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    due_date DATE NOT NULL,
    filed_at TIMESTAMP WITH TIME ZONE,
    document_id VARCHAR(255),
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tax deposits tracking
CREATE TABLE IF NOT EXISTS company_tax_deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    payroll_run_id UUID NOT NULL REFERENCES company_payroll_runs(id) ON DELETE CASCADE,
    check_deposit_id VARCHAR(255),
    tax_id VARCHAR(255) NOT NULL,
    tax_label VARCHAR(100) NOT NULL,
    tax_type VARCHAR(50) NOT NULL,
    amount VARCHAR(50) NOT NULL,
    due_date DATE NOT NULL,
    funding_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    deposit_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    deposited_at TIMESTAMP WITH TIME ZONE,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Payment tracking
CREATE TABLE IF NOT EXISTS company_payroll_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    payroll_run_id UUID REFERENCES company_payroll_runs(id) ON DELETE CASCADE,
    check_payment_id VARCHAR(255),
    payment_type VARCHAR(50) NOT NULL,
    amount VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    recipient_name VARCHAR(255),
    recipient_bank_mask VARCHAR(10),
    initiated_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    failed_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Funding failures
CREATE TABLE IF NOT EXISTS company_funding_failures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    payroll_run_id UUID NOT NULL REFERENCES company_payroll_runs(id) ON DELETE CASCADE,
    payment_id UUID REFERENCES company_payroll_payments(id),
    check_requirement_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'failed',
    failure_reason TEXT NOT NULL,
    wire_bank_name VARCHAR(255),
    wire_routing_number VARCHAR(20),
    wire_account_number VARCHAR(50),
    wire_beneficiary_name VARCHAR(255),
    wire_reference_number VARCHAR(100),
    wire_amount VARCHAR(50),
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ===========================================
-- EMPLOYEE TABLES
-- ===========================================

-- Employee bank accounts
CREATE TABLE IF NOT EXISTS employee_bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES company_employees(id) ON DELETE CASCADE,
    check_bank_account_id VARCHAR(255),
    institution_name VARCHAR(255) NOT NULL,
    routing_number_masked VARCHAR(20) NOT NULL,
    account_number_masked VARCHAR(20) NOT NULL,
    account_type VARCHAR(20) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending_verification',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Employee benefit enrollments
CREATE TABLE IF NOT EXISTS employee_benefit_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    benefit_plan_id UUID REFERENCES company_benefit_plans(id) ON DELETE SET NULL,
    employee_id UUID NOT NULL REFERENCES company_employees(id) ON DELETE CASCADE,
    check_enrollment_id VARCHAR(255),
    benefit_type VARCHAR(50) NOT NULL,
    description VARCHAR(255),
    effective_start DATE NOT NULL,
    effective_end DATE,
    company_contribution_amount VARCHAR(50),
    company_contribution_percent NUMERIC(5,2),
    employee_contribution_amount VARCHAR(50),
    employee_contribution_percent NUMERIC(5,2),
    employee_period_amount VARCHAR(50),
    period VARCHAR(20),
    hsa_contribution_limit VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_benefit_enrollments_unique
    ON employee_benefit_enrollments(benefit_plan_id, employee_id)
    WHERE benefit_plan_id IS NOT NULL;

-- Employee post-tax deductions
CREATE TABLE IF NOT EXISTS employee_post_tax_deductions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES company_employees(id) ON DELETE CASCADE,
    check_deduction_id VARCHAR(255),
    deduction_type VARCHAR(50) NOT NULL,
    description VARCHAR(255) NOT NULL,
    effective_start DATE NOT NULL,
    effective_end DATE,
    cs_external_id VARCHAR(100),
    cs_agency VARCHAR(10),
    cs_issue_date DATE,
    cs_amount VARCHAR(50),
    cs_max_percent NUMERIC(5,2),
    misc_amount VARCHAR(50),
    misc_percent NUMERIC(5,2),
    misc_total_amount VARCHAR(50),
    misc_annual_limit VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Employee earning rates
CREATE TABLE IF NOT EXISTS employee_earning_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES company_employees(id) ON DELETE CASCADE,
    check_rate_id VARCHAR(255),
    rate_type VARCHAR(20) NOT NULL,
    amount VARCHAR(50) NOT NULL,
    effective_start DATE NOT NULL,
    effective_end DATE,
    earning_code_id UUID REFERENCES company_earning_codes(id),
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Employee net pay splits
CREATE TABLE IF NOT EXISTS employee_net_pay_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES company_employees(id) ON DELETE CASCADE,
    check_split_id VARCHAR(255),
    is_default BOOLEAN DEFAULT true,
    deactivated_at TIMESTAMP WITH TIME ZONE,
    deactivated_reason VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Employee net pay split items
CREATE TABLE IF NOT EXISTS employee_net_pay_split_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    net_pay_split_id UUID NOT NULL REFERENCES employee_net_pay_splits(id) ON DELETE CASCADE,
    bank_account_id UUID NOT NULL REFERENCES employee_bank_accounts(id),
    priority INTEGER NOT NULL,
    amount VARCHAR(50),
    percentage NUMERIC(5,2),
    CONSTRAINT valid_employee_split CHECK (
        (amount IS NOT NULL AND percentage IS NULL) OR
        (amount IS NULL AND percentage IS NOT NULL) OR
        (amount IS NULL AND percentage IS NULL)
    )
);

-- Employee tax parameter settings
CREATE TABLE IF NOT EXISTS employee_tax_param_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES company_employees(id) ON DELETE CASCADE,
    check_param_id VARCHAR(255),
    jurisdiction_id VARCHAR(255) NOT NULL,
    jurisdiction_label VARCHAR(100) NOT NULL,
    param_name VARCHAR(100) NOT NULL,
    param_label VARCHAR(255) NOT NULL,
    param_type VARCHAR(50) NOT NULL,
    value VARCHAR(255),
    effective_start DATE,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_tax_params_unique
    ON employee_tax_param_settings (employee_id, COALESCE(check_param_id, ''));

-- Employee tax statements (W-2, W-2C)
CREATE TABLE IF NOT EXISTS employee_tax_statements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES company_employees(id) ON DELETE CASCADE,
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_statement_id VARCHAR(255),
    year INTEGER NOT NULL,
    statement_type VARCHAR(10) NOT NULL,
    amends_id UUID REFERENCES employee_tax_statements(id),
    amended_by_id UUID REFERENCES employee_tax_statements(id),
    document_id VARCHAR(255),
    publication_status VARCHAR(50) NOT NULL,
    published_at TIMESTAMP WITH TIME ZONE,
    delivery_method VARCHAR(20) NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ===========================================
-- CONTRACTOR TABLES
-- ===========================================

-- Contractor bank accounts
CREATE TABLE IF NOT EXISTS contractor_bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contractor_id UUID NOT NULL REFERENCES company_contractors(id) ON DELETE CASCADE,
    check_bank_account_id VARCHAR(255),
    institution_name VARCHAR(255) NOT NULL,
    routing_number_masked VARCHAR(20) NOT NULL,
    account_number_masked VARCHAR(20) NOT NULL,
    account_type VARCHAR(20) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending_verification',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Contractor net pay splits
CREATE TABLE IF NOT EXISTS contractor_net_pay_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contractor_id UUID NOT NULL REFERENCES company_contractors(id) ON DELETE CASCADE,
    check_split_id VARCHAR(255),
    is_default BOOLEAN DEFAULT true,
    deactivated_at TIMESTAMP WITH TIME ZONE,
    deactivated_reason VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Contractor net pay split items
CREATE TABLE IF NOT EXISTS contractor_net_pay_split_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    net_pay_split_id UUID NOT NULL REFERENCES contractor_net_pay_splits(id) ON DELETE CASCADE,
    bank_account_id UUID NOT NULL REFERENCES contractor_bank_accounts(id),
    priority INTEGER NOT NULL,
    amount VARCHAR(50),
    percentage NUMERIC(5,2),
    CONSTRAINT valid_contractor_split CHECK (
        (amount IS NOT NULL AND percentage IS NULL) OR
        (amount IS NULL AND percentage IS NOT NULL) OR
        (amount IS NULL AND percentage IS NULL)
    )
);

-- Contractor tax statements (1099-NEC)
CREATE TABLE IF NOT EXISTS contractor_tax_statements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contractor_id UUID NOT NULL REFERENCES company_contractors(id) ON DELETE CASCADE,
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    check_statement_id VARCHAR(255),
    year INTEGER NOT NULL,
    statement_type VARCHAR(10) NOT NULL DEFAULT '1099_nec',
    document_id VARCHAR(255),
    publication_status VARCHAR(50) NOT NULL,
    published_at TIMESTAMP WITH TIME ZONE,
    delivery_method VARCHAR(20) NOT NULL,
    electronic_consent_provided BOOLEAN DEFAULT false,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ===========================================
-- INDEXES
-- ===========================================

-- Company tables
CREATE INDEX IF NOT EXISTS idx_company_signatories_payroll ON company_signatories(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_bank_accounts_payroll ON company_bank_accounts(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_benefit_plans_payroll ON company_benefit_plans(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_benefit_plans_type ON company_benefit_plans(benefit_type);
CREATE INDEX IF NOT EXISTS idx_company_payroll_runs_payroll ON company_payroll_runs(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_payroll_runs_status ON company_payroll_runs(status);
CREATE INDEX IF NOT EXISTS idx_company_payroll_run_items_run ON company_payroll_run_items(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_company_contractor_payments_run ON company_contractor_payments(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_company_pay_schedules_payroll ON company_pay_schedules(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_earning_codes_payroll ON company_earning_codes(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_tax_param_settings_payroll ON company_tax_param_settings(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_tax_param_settings_jurisdiction ON company_tax_param_settings(jurisdiction_id);
CREATE INDEX IF NOT EXISTS idx_company_tax_filings_payroll ON company_tax_filings(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_tax_filings_year ON company_tax_filings(year);
CREATE INDEX IF NOT EXISTS idx_company_tax_filings_status ON company_tax_filings(status);
CREATE INDEX IF NOT EXISTS idx_company_tax_deposits_run ON company_tax_deposits(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_company_tax_deposits_status ON company_tax_deposits(deposit_status);
CREATE INDEX IF NOT EXISTS idx_company_tax_deposits_due ON company_tax_deposits(due_date);
CREATE INDEX IF NOT EXISTS idx_company_payroll_payments_run ON company_payroll_payments(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_company_payroll_payments_type ON company_payroll_payments(payment_type);
CREATE INDEX IF NOT EXISTS idx_company_payroll_payments_status ON company_payroll_payments(status);
CREATE INDEX IF NOT EXISTS idx_company_funding_failures_run ON company_funding_failures(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_company_funding_failures_status ON company_funding_failures(status);

-- Employee tables
CREATE INDEX IF NOT EXISTS idx_employee_bank_accounts_employee ON employee_bank_accounts(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_benefit_enrollments_employee ON employee_benefit_enrollments(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_benefit_enrollments_plan ON employee_benefit_enrollments(benefit_plan_id);
CREATE INDEX IF NOT EXISTS idx_employee_benefit_enrollments_type ON employee_benefit_enrollments(benefit_type);
CREATE INDEX IF NOT EXISTS idx_employee_post_tax_deductions_employee ON employee_post_tax_deductions(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_post_tax_deductions_type ON employee_post_tax_deductions(deduction_type);
CREATE INDEX IF NOT EXISTS idx_employee_earning_rates_employee ON employee_earning_rates(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_earning_rates_effective ON employee_earning_rates(effective_start, effective_end);
CREATE INDEX IF NOT EXISTS idx_employee_net_pay_splits_employee ON employee_net_pay_splits(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_net_pay_split_items_split ON employee_net_pay_split_items(net_pay_split_id);
CREATE INDEX IF NOT EXISTS idx_employee_tax_param_settings_employee ON employee_tax_param_settings(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_tax_param_settings_jurisdiction ON employee_tax_param_settings(jurisdiction_id);
CREATE INDEX IF NOT EXISTS idx_employee_tax_statements_employee ON employee_tax_statements(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_tax_statements_year ON employee_tax_statements(year);
CREATE INDEX IF NOT EXISTS idx_employee_tax_statements_status ON employee_tax_statements(publication_status);

-- Contractor tables
CREATE INDEX IF NOT EXISTS idx_contractor_bank_accounts_contractor ON contractor_bank_accounts(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_net_pay_splits_contractor ON contractor_net_pay_splits(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_net_pay_split_items_split ON contractor_net_pay_split_items(net_pay_split_id);
CREATE INDEX IF NOT EXISTS idx_contractor_tax_statements_contractor ON contractor_tax_statements(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_tax_statements_year ON contractor_tax_statements(year);
