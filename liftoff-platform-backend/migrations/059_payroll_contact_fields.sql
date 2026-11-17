-- Add phone and middle_name fields to employee/contractor tables

ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100);
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS phone_country_code VARCHAR(5) DEFAULT '+1';
ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS phone_country_code VARCHAR(5) DEFAULT '+1';
ALTER TABLE company_contractors ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
