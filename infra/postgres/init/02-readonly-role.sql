-- Runs once, on first initialisation of the data volume, as ${POSTGRES_USER}.
--
-- `voyager_readonly` is the role mock-gds connects with. mock-gds stands in
-- for a third-party GDS: it reads seeded inventory so its answers stay
-- consistent with the rest of the demo, but a third party has no business
-- writing to the booking database, and the grants here make that structural
-- rather than a matter of trust.

\getenv mock_password MOCK_DB_PASSWORD

-- The trailing semicolon lives inside the format string: psql substitutes
-- `:create_readonly_role` literally, and without it the next statement is
-- swallowed into this one.
SELECT format('CREATE ROLE voyager_readonly LOGIN PASSWORD %L;', :'mock_password')
       AS create_readonly_role \gset
:create_readonly_role

GRANT CONNECT ON DATABASE :"DBNAME" TO voyager_readonly;
GRANT USAGE ON SCHEMA voyager, public TO voyager_readonly;

-- The tables do not exist yet -- Alembic creates them on the first `make
-- migrate`. Default privileges cover everything ${POSTGRES_USER} creates from
-- here on, so the grant does not have to be repeated after every migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA voyager GRANT SELECT ON TABLES TO voyager_readonly;

-- Belt and braces for anything that already exists.
GRANT SELECT ON ALL TABLES IN SCHEMA voyager TO voyager_readonly;

ALTER ROLE voyager_readonly SET search_path TO voyager, public;

-- A slow mock must not be able to hold a transaction open across a demo.
ALTER ROLE voyager_readonly SET statement_timeout TO '10s';
ALTER ROLE voyager_readonly SET idle_in_transaction_session_timeout TO '30s';
