// Integration Test Per-File Setup
// Sets env vars for test Postgres connection

process.env.NODE_ENV = 'test';
process.env.ENVIRONMENT = 'test';
process.env.GCP_PROJECT_ID = 'test-project';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5433';
process.env.DB_NAME = 'liftoff_control_test';
process.env.DB_USER = 'liftoff_test';
process.env.DB_PASSWORD = 'test_password';
