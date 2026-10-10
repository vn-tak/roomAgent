# D1 migration preflight (P1-03)

Gate: `ROOMAGENT_P1_MIGRATION_LEDGER_PASS` (local evidence; no remote ledger was read).

## Finding

Local migration smoke tests passed, but nothing verified the target database identity,
ledger, or schema before `wrangler d1 migrations apply` (`MIGRATION_LEDGER_GATE_MISSING`).

## Previous behavior

- Applying migrations relied on the Wrangler binding name alone.
- Wrangler's `d1_migrations` ledger stores only `id`, `name`, and `applied_at`. It holds no
  checksum, so an edited historical file would go unnoticed.
- An empty staging database, a partial one, and a mismatched one looked the same.

## Root cause

No pre-deploy verification tool or runbook existed.

## Implementation

`scripts/d1_preflight.py` (standard library only) never contacts Cloudflare. It consumes JSON
captured by an operator with read-only commands and emits machine-readable gates. Migrations
may be applied only when `result = PASS` / `apply_allowed = true`.

| Input                                | Purpose                                                  |
| ------------------------------------ | -------------------------------------------------------- |
| `deploy/staging/d1-target.json`      | Expected environment, account ID, database name and ID   |
| `apps/api/wrangler.staging.jsonc`    | The config that `migrations apply` would use             |
| `deploy/d1/migrations.manifest.json` | Ordered file names and SHA-256 checksums (`0001`–`0015`) |
| `<evidence>/account.json`            | `{"account_id": …}` pinned for the command session       |
| `<evidence>/info.json`               | `wrangler d1 info … --json` (`uuid`, `name`)             |
| `<evidence>/ledger.json`             | `d1_migrations` rows, or `{"absent": true}`              |
| `<evidence>/schema.json`             | `sqlite_master` rows                                     |
| `<evidence>/foreign_keys.json`       | `PRAGMA foreign_key_check` rows                          |

### Gates

| Gate                                | Passes when                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STAGING_DB_IDENTITY_VERIFIED`      | Target is `staging` with a real account ID and database UUID; staging config is the `-staging` Worker pinned to that account; its `DB` binding has that ID, name, and the repo `migrations/`; evidence matches |
| `STAGING_MIGRATION_PLAN_VERIFIED`   | Files are `NNNN_name.sql`, contiguous from `0001`, no duplicate numbers, and identical to the manifest (name, order, SHA-256)                                                                                  |
| `STAGING_MIGRATION_LEDGER_VERIFIED` | Ledger names are unique, all known, and form an exact prefix of the manifest (no gaps or reordering)                                                                                                           |
| `STAGING_MIGRATION_SCHEMA_VERIFIED` | Normalized `sqlite_master` (excluding `sqlite_*`, `_cf_*`, `d1_migrations`) matches the fingerprint of the first _k_ migrations applied locally, and the FK check is empty                                     |

### Classification

| Classification                | Meaning                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `EMPTY_STAGING_DATABASE`      | No ledger and no application schema. Not an error: apply all.      |
| `PARTIALLY_MIGRATED_DATABASE` | Ledger is a clean prefix matching the schema. Apply the remainder. |
| `FULLY_MIGRATED_DATABASE`     | Nothing pending                                                    |
| `DATABASE_ID_MISMATCH`        | Config or evidence points to a different database. Stop.           |
| `LEDGER_INCONSISTENT`         | Gap, duplicate, unknown, or reordered ledger entries. Stop.        |
| `UNEXPECTED_SCHEMA`           | Drift, failed partial apply, or schema without a ledger. Stop.     |

The committed target deliberately holds a `REPLACE_…` database ID. Until the operator records
the provisioned UUID, the identity gate fails (`TARGET_DATABASE_ID_UNSET`).

## Runbook (operator; remote commands are not executed in this task)

```sh
cd apps/api
export CLOUDFLARE_ACCOUNT_ID=<account_id from deploy/staging/d1-target.json>
EVID=$(mktemp -d)
printf '{"account_id":"%s"}\n' "$CLOUDFLARE_ACCOUNT_ID" > "$EVID/account.json"
DB=ai-company-os-staging
CFG=--config=wrangler.staging.jsonc

# Read-only evidence.
npx wrangler d1 info "$DB" $CFG --json > "$EVID/info.json"
npx wrangler d1 execute "$DB" $CFG --remote --json \
  --command "SELECT type, name, tbl_name, sql FROM sqlite_master" > "$EVID/schema.json"
npx wrangler d1 execute "$DB" $CFG --remote --json \
  --command "PRAGMA foreign_key_check" > "$EVID/foreign_keys.json"
# Only if schema.json lists d1_migrations; otherwise write {"absent": true}.
npx wrangler d1 execute "$DB" $CFG --remote --json \
  --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id" > "$EVID/ledger.json"

cd ../..
python3 scripts/d1_preflight.py verify --evidence-dir "$EVID" --out "$EVID/preflight.json"
# Exit code 0 and "apply_allowed": true are both required.

# Before applying anything, record a recovery point (see migration-0013-recovery.md).
npx wrangler d1 time-travel info "$DB" --config=apps/api/wrangler.staging.jsonc
# Then, with operator approval only:
# npx wrangler d1 migrations apply "$DB" --remote --config=apps/api/wrangler.staging.jsonc
# Re-capture evidence and re-run verify: expect FULLY_MIGRATED_DATABASE / PASS.
```

`wrangler d1 info` field names beyond `uuid`/`name` are not documented. The tool reads only
those two fields. Wrangler applies files in order. Each file plus its ledger insert is rolled
back on error, per the Wrangler D1 command reference.

## Local commands (CI)

```sh
python3 scripts/d1_preflight.py manifest   # manifest matches files
python3 scripts/d1_preflight.py plan       # plan gate on the repository
python3 scripts/test-d1-preflight.py       # 16 regression tests
```

When a new migration is added, regenerate the manifest with
`python3 scripts/d1_preflight.py manifest --write` in the same reviewed change. Historical
entries must not change.

## Security impact

Applying migrations now requires positive proof of the target database, not a name match, and
historical migrations are tamper-evident.

## Regression tests (`scripts/test-d1-preflight.py`)

| Required case            | Evidence                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| Clean schema             | `EMPTY_STAGING_DATABASE`, PASS, all 15 pending                      |
| 0010 → latest upgrade    | `PARTIALLY_MIGRATED_DATABASE` (0011–0015 pending) → `FULLY_…`, PASS |
| Missing migration        | ledger 0001–0010 + 0012 → `MISSING_MIGRATION:0011…`, blocked        |
| Duplicate migration      | duplicate ledger name; duplicate `0003_*` file → FAIL               |
| Unexpected schema        | extra table; schema without ledger → `UNEXPECTED_SCHEMA`            |
| Wrong database identity  | UUID, account, config ID, and non-staging Worker mismatches → FAIL  |
| Modified historical file | edited `0005` → `MIGRATION_MODIFIED`                                |
| Failed migration         | non-atomic partial 0013 → drift FAIL; rolled-back attempt → PASS    |
| FK violation             | dangling `organizations.created_by_user_id` → FAIL                  |
| Missing evidence         | missing ledger, FK, schema, or identity evidence fails closed       |

## Remaining risks

- Schema fingerprints assume D1 stores `sqlite_master.sql` as SQLite does locally. A benign
  difference would fail closed (block), not pass silently. It must be confirmed on the first
  staging run.
- Evidence is collected by the operator. The tool proves consistency of what it is given, so
  the runbook pins `CLOUDFLARE_ACCOUNT_ID` and the staging config explicitly.

## Cloudflare remote verification required

- `wrangler d1 info --json` output shape, `d1_migrations` presence on an empty database, and
  `PRAGMA foreign_key_check` on remote D1.
- `REMOTE_NOT_TESTED`.
