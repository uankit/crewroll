-- Preview-only candidate. Not part of the automatic Kysely migration chain.
-- Run only after reviewing a fresh catalog receipt and the local proof.
-- Caller MUST wrap this body in one transaction and set, within that transaction:
--   SET LOCAL crewroll.hardening_expected_database = 'postgres';
-- 'crewroll_test_pg17' is accepted only for the established disposable local proof.
-- No backend grants, RLS policies, owners, schema USAGE, or service_role grants change.
-- The creator-global function default below affects future postgres-created
-- functions in this database; future helpers need explicit EXECUTE grants.

DO $guard$
BEGIN
  IF current_setting('crewroll.hardening_expected_database', true) IS NULL
     OR current_database() <> current_setting('crewroll.hardening_expected_database', true)
     OR current_database() NOT IN ('postgres', 'crewroll_test_pg17') THEN
    RAISE EXCEPTION 'Preview hardening requires the explicitly selected database';
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Preview hardening requires the inspected migration owner';
  END IF;
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL
     OR to_regrole('crewroll_api') IS NULL THEN
    RAISE EXCEPTION 'Preview hardening requires the existing application/API roles';
  END IF;
END
$guard$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated, PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  FROM anon, authenticated, PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- A per-schema REVOKE cannot remove PostgreSQL's global PUBLIC EXECUTE default.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
