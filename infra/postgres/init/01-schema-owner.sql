-- Runs once, on first initialisation of the data volume, as ${POSTGRES_USER}
-- against ${POSTGRES_DB}. Creates the `voyager` schema that Alembic owns
-- (see 05-FUNCTIONALITY.md § 3) and puts it on the default search path.

CREATE SCHEMA IF NOT EXISTS voyager;

-- pg_stat_statements is preloaded in postgresql.conf; the extension itself has
-- to be created in the database before Database Monitoring can read it.
-- It belongs in public, not in voyager: the application schema is owned by
-- Alembic, and the monitoring role should not depend on it being on the path.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA public;

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path TO voyager, public',
                 current_database());
END $$;

ALTER ROLE CURRENT_USER SET search_path TO voyager, public;
