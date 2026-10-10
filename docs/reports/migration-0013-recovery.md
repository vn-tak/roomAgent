# Migration 0013 recovery plan (P1-04)

Gate: `ROOMAGENT_P1_MIGRATION_RECOVERY_PLAN_PASS` (offline evidence; remote restore not
certified).

## Finding

`0013_direct_artifact_size.sql` rebuilds `artifact_versions`. It drops three referencing
triggers, copies rows into `artifact_versions_v2`, drops the old table, renames the new one,
and restores the tenant and immutability triggers. Local tests covered data and triggers, but
there was no backup, restore, or failure procedure (`MIGRATION_0013_RECOVERY_PLAN`).

## Previous behavior

No runbook. Rollback was implicitly assumed to be "deploy the previous Worker".

## Root cause

Remediation v1 verified forward behavior only.

## Code rollback is not database restore

| Operation        | What it changes                       | What it cannot do                                  |
| ---------------- | ------------------------------------- | -------------------------------------------------- |
| Code rollback    | Worker version (`wrangler rollback`)  | Undo DDL, restore dropped tables/triggers, or data |
| Database restore | Entire D1 database to a point in time | Keep writes made after that point (they are lost)  |

Deploying an older Worker does not roll back the D1 schema. After 0013, older code still works
because the column set is unchanged and only the size bound widened. A database restore is
needed only when integrity verification fails.

## D1 capabilities relied on (official docs, verified 2026-10-09)

- Time Travel is always on. Restore to any minute within 30 days on Workers Paid (7 on Free)
  ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)).
- `wrangler d1 time-travel info <DB>` returns the current bookmark;
  `wrangler d1 time-travel restore <DB> --bookmark=<b>` (or `--timestamp`) restores
  ([commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)).
- Restore is destructive and in place. It returns a bookmark that undoes the restore.
- `version: alpha` databases do not support Time Travel. Staging must be created as a
  current D1 database.
- `wrangler d1 migrations apply` rolls back a migration that errors and keeps earlier ones
  ([commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)).
- D1 enforces foreign keys during migrations. No table references `artifact_versions` by
  foreign key (checked in `migrations/`), so `DROP TABLE artifact_versions` cascades nowhere.
- `wrangler d1 export` blocks other requests while it runs. It is an optional extra copy, not
  the primary checkpoint.

## Runbook

1. **Pre-migration inspection**: run the D1 preflight. It must report
   `PARTIALLY_MIGRATED_DATABASE` with `0013_direct_artifact_size.sql` pending and all gates
   PASS. Record row counts:

   ```sql
   SELECT (SELECT COUNT(*) FROM artifacts) AS artifacts,
          (SELECT COUNT(*) FROM artifact_versions) AS versions,
          (SELECT COUNT(*) FROM reviews) AS reviews,
          (SELECT COUNT(*) FROM approvals) AS approvals,
          (SELECT COUNT(*) FROM workflow_runs) AS runs;
   ```

2. **Backup / recovery checkpoint**: pause writers. Do not route operator traffic, and keep
   queue consumers idle by deploying no new producers. Then
   `wrangler d1 time-travel info ai-company-os-staging --config=apps/api/wrangler.staging.jsonc`
   and record the bookmark with a UTC timestamp in the change ticket. Optionally run
   `wrangler d1 export … --output pre-0013.sql` during the paused window.
3. **Migration execution**:
   `wrangler d1 migrations apply ai-company-os-staging --remote --config=apps/api/wrangler.staging.jsonc`,
   operator-approved.
4. **Post-migration integrity verification**: re-capture evidence and re-run the preflight.
   It must report `FULLY_MIGRATED_DATABASE`, PASS, and an empty FK check. Re-run the counts
   (all must match). Confirm the triggers exist:

   ```sql
   SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (
     'artifact_versions_same_org', 'artifact_versions_no_update', 'artifact_versions_no_delete',
     'reviews_same_org', 'approvals_same_org', 'workflow_runs_same_org');
   ```

   Six rows are expected.

5. **Failure classification**:

   | Observation                                                   | Class             | Action                        |
   | ------------------------------------------------------------- | ----------------- | ----------------------------- |
   | `apply` errored on 0013; preflight shows 0012, PASS           | Atomic failure    | No restore. Fix cause, retry. |
   | Preflight `UNEXPECTED_SCHEMA` after an error                  | Partial / drift   | Restore to bookmark           |
   | Counts differ, a trigger is missing, or FK check is not empty | Integrity failure | Restore to bookmark           |
   | 0013 applied cleanly, later application bug                   | Code defect       | Code rollback only            |

6. **Restore decision**: an operator approves the restore, accepting that writes after the
   bookmark are lost. Then
   `wrangler d1 time-travel restore ai-company-os-staging --bookmark=<recorded> --config=…` and
   keep the returned undo bookmark.
7. **Recovery validation**: re-run the preflight. Expect `PARTIALLY_MIGRATED_DATABASE` at
   0012 with schema PASS, and counts equal to step 1. Only then re-attempt step 3.

## Offline evidence (`scripts/test-migrations.py`)

| Test                                                      | Proves                                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `test_populated_0010_to_latest_preserves_data_and_guards` | 0010 → 0015 keeps artifacts, versions, reviews, approvals, and workflow runs byte-identical; tenant, immutability, and FK guards hold   |
| `test_restore_checkpoint_returns_exact_pre_0013_state`    | A checkpoint restore returns the exact 0012 schema fingerprint and data, drops post-migration writes, and can be migrated forward again |
| `test_failed_0013_rolls_back_atomically`                  | A failing 0013 inside one transaction leaves the 0012 schema and data intact, including the dropped triggers                            |
| `test_upgrade_preserves_existing_data` (existing)         | Size, review, approval, room, and trigger behavior after upgrade                                                                        |
| `test_failed_migration_is_detected_unless_rolled_back`    | The preflight distinguishes atomic rollback (PASS) from partial drift (FAIL)                                                            |

The checkpoint is a SQLite backup standing in for a Time Travel bookmark. It shows the
procedure is sound. It does not certify D1's remote restore.

0013 is unchanged. Its checksum is pinned in `deploy/d1/migrations.manifest.json`.

## Security impact

The immutability and tenant triggers cannot silently disappear. The post-migration trigger
check and schema fingerprint detect any loss before traffic resumes.

## Remaining risks

- A restore discards every write after the bookmark. Pausing writers keeps that window empty.
- Time Travel behavior and the restore duration on a populated staging database are untested.

## Cloudflare remote verification required

- Bookmark capture and restore on the staging D1 database, plus confirmation that the
  database is not `alpha`.
- `REMOTE_NOT_TESTED`.
