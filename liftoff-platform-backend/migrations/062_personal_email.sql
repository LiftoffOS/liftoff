-- Add personal/alternative email field for employees and contractors
-- The existing 'email' column stores the company/work email (used for workspace invitations).
-- 'personal_email' stores the employee/contractor's personal email for
-- tax documents (W-2/1099), HR records, and contact outside of work.

ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS personal_email VARCHAR(255);
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS personal_email VARCHAR(255);
