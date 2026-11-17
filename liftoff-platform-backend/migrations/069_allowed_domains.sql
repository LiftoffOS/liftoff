-- Access Gate: allowed domains whitelist
-- Per implementation plan 1a: domain-based access control

CREATE TABLE allowed_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO allowed_domains (domain) VALUES ('example.com');
