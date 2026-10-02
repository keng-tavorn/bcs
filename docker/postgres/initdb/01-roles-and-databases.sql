-- Runs once when the local Postgres volume is created (spec §5.3).
-- bcs_migrator owns the schema and runs migrations (DIRECT_URL); bcs_app is the runtime role (DATABASE_URL).
-- Table-level GRANT/REVOKE live in the migrations themselves, because db:reset drops and recreates the schema.
CREATE ROLE bcs_migrator LOGIN PASSWORD 'bcs_migrator' CREATEDB;
CREATE ROLE bcs_app LOGIN PASSWORD 'bcs_app';

ALTER DATABASE bcs OWNER TO bcs_migrator;
-- bcs: development · bcs_test: integration tests · bcs_verify: pnpm verify db gate · bcs_e2e: Playwright
-- bcs_tpl: migrated template that tests clone with CREATE DATABASE … TEMPLATE
CREATE DATABASE bcs_test OWNER bcs_migrator;
CREATE DATABASE bcs_verify OWNER bcs_migrator;
CREATE DATABASE bcs_e2e OWNER bcs_migrator;
CREATE DATABASE bcs_tpl OWNER bcs_migrator;

\connect bcs
ALTER SCHEMA public OWNER TO bcs_migrator;
GRANT CONNECT ON DATABASE bcs TO bcs_app;
\connect bcs_test
ALTER SCHEMA public OWNER TO bcs_migrator;
GRANT CONNECT ON DATABASE bcs_test TO bcs_app;
\connect bcs_verify
ALTER SCHEMA public OWNER TO bcs_migrator;
GRANT CONNECT ON DATABASE bcs_verify TO bcs_app;
\connect bcs_e2e
ALTER SCHEMA public OWNER TO bcs_migrator;
GRANT CONNECT ON DATABASE bcs_e2e TO bcs_app;
\connect bcs_tpl
ALTER SCHEMA public OWNER TO bcs_migrator;
GRANT CONNECT ON DATABASE bcs_tpl TO bcs_app;
