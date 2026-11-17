-- Payroll setup milestones
-- Tracks admin and personnel onboarding progress

-- Tenant-level: admin company setup milestones
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_profile_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_benefits_configured_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_payroll_completed_at TIMESTAMP WITH TIME ZONE;

-- Company payroll settings (links tenant to Check HQ company)
CREATE TABLE IF NOT EXISTS company_payroll_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    check_company_id VARCHAR(255),
    check_workplace_id VARCHAR(255),
    legal_name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    ein_masked VARCHAR(20),
    phone_country_code VARCHAR(5) DEFAULT '+1',
    phone VARCHAR(20),
    onboard_status VARCHAR(50) NOT NULL DEFAULT 'blocking',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tenant_id)
);

-- Company employees
CREATE TABLE IF NOT EXISTS company_employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id),
    check_employee_id VARCHAR(255) UNIQUE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    onboard_status VARCHAR(50) NOT NULL DEFAULT 'blocking',
    -- Personnel onboarding milestones (per-user-per-tenant)
    employee_setup_completed_at TIMESTAMP WITH TIME ZONE,
    benefits_enrollment_completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Company contractors
CREATE TABLE IF NOT EXISTS company_contractors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_payroll_id UUID NOT NULL REFERENCES company_payroll_settings(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id),
    check_contractor_id VARCHAR(255) UNIQUE,
    contractor_type VARCHAR(20) NOT NULL DEFAULT 'individual',
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    business_name VARCHAR(255),
    start_date DATE NOT NULL,
    onboard_status VARCHAR(50) NOT NULL DEFAULT 'blocking',
    -- Personnel onboarding milestone
    contractor_setup_completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_payroll_settings_tenant ON company_payroll_settings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_company_employees_payroll ON company_employees(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_employees_account ON company_employees(account_id);
CREATE INDEX IF NOT EXISTS idx_company_employees_email ON company_employees(email);
CREATE INDEX IF NOT EXISTS idx_company_contractors_payroll ON company_contractors(company_payroll_id);
CREATE INDEX IF NOT EXISTS idx_company_contractors_account ON company_contractors(account_id);
