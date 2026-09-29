-- Database Monitoring setup (02-TECH-STACK.md § 6.2).
--
-- Runs as ${POSTGRES_USER} against ${POSTGRES_DB}: on first boot from
-- /docker-entrypoint-initdb.d, and afterwards from `make dbm-setup`, which is
-- the only way to reach a volume that has already been initialised. Every
-- statement here is therefore written to be safe to run twice.

\getenv dd_password DD_PG_PASSWORD

-- The monitoring role. The branch is psql's rather than plpgsql's because
-- psql deliberately does not substitute its variables inside a dollar-quoted
-- body, so a DO block here would receive the literal text `:'dd_password'`.
-- The trailing semicolons live inside the format strings for the same reason
-- 02-readonly-role.sql puts them there: the variable expands to raw text, and
-- without one the following statement is swallowed into this one.
SELECT format('CREATE ROLE datadog LOGIN PASSWORD %L;', :'dd_password')
       AS create_datadog_role \gset
SELECT format('ALTER ROLE datadog LOGIN PASSWORD %L;', :'dd_password')
       AS reset_datadog_password \gset

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datadog')
       AS datadog_role_missing \gset

-- Re-running with a rotated DD_PG_PASSWORD is the supported way to change it:
-- the existing role keeps its grants and only the password moves.
\if :datadog_role_missing
:create_datadog_role
\else
:reset_datadog_password
\endif

-- pg_monitor carries the bulk of what the check reads: pg_stat_activity with
-- other sessions' query text, pg_stat_statements, and the pg_stat_* views.
-- Without it the check runs, reports connection counts, and silently returns
-- nothing for every query-level metric -- which looks like an idle database.
GRANT pg_monitor TO datadog;
ALTER ROLE datadog INHERIT;

GRANT CONNECT ON DATABASE :"DBNAME" TO datadog;
GRANT USAGE ON SCHEMA public TO datadog;
GRANT SELECT ON pg_stat_database TO datadog;

-- `relations` and `collect_schemas` walk the application schema for per-table
-- statistics and column metadata. Both need USAGE on it; neither needs SELECT,
-- because the statistics live in the catalog rather than in the tables.
GRANT USAGE ON SCHEMA voyager TO datadog;

CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA public;

CREATE SCHEMA IF NOT EXISTS datadog;
GRANT USAGE ON SCHEMA datadog TO datadog;

-- Explain plans. The Agent samples a normalised statement and asks this
-- function to plan it; SECURITY DEFINER is what lets a role with no rights on
-- voyager.bookings still get a plan for a query against it, and is why the
-- function takes a statement rather than executing one -- EXPLAIN without
-- ANALYZE never runs the query it is handed.
CREATE OR REPLACE FUNCTION datadog.explain_statement(
  l_query text,
  OUT explain json
)
RETURNS SETOF json AS $$
DECLARE
  curs REFCURSOR;
  plan json;
BEGIN
  OPEN curs FOR EXECUTE pg_catalog.concat('EXPLAIN (FORMAT JSON) ', l_query);
  FETCH curs INTO plan;
  CLOSE curs;
  RETURN QUERY SELECT plan;
END;
$$
LANGUAGE plpgsql
RETURNS NULL ON NULL INPUT
SECURITY DEFINER;

-- The database's search_path is `voyager, public` (01-schema-owner.sql), which
-- the function inherits from the calling session. That is deliberate: the
-- statements the Agent samples name tables unqualified, exactly as the
-- application wrote them, and a locked-down search_path here would make every
-- one of them fail to plan.
GRANT EXECUTE ON FUNCTION datadog.explain_statement(text) TO datadog;

-- A monitoring role must never be the reason a demo stalls. An EXPLAIN that
-- cannot be planned in ten seconds is not worth waiting for, and a sampler
-- that leaves a transaction open would block the vacuum it is reporting on.
ALTER ROLE datadog SET statement_timeout TO '10s';
ALTER ROLE datadog SET idle_in_transaction_session_timeout TO '30s';
