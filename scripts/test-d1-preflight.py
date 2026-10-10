"""Regression tests for the offline D1 staging preflight and staging Wrangler config gates."""
import copy
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import d1_preflight as pf  # noqa: E402

FILES = pf.migration_files()
NAMES = [path.name for path in FILES]
MANIFEST = json.loads(pf.MANIFEST.read_text())
ACCOUNT = "1" * 32
DATABASE_ID = "11111111-2222-4333-8444-555555555555"
TARGET = {
    "environment": "staging",
    "account_id": ACCOUNT,
    "binding": "DB",
    "database_name": "ai-company-os-staging",
    "database_id": DATABASE_ID,
}
CONFIG = {
    "name": "ai-company-os-api-staging",
    "account_id": ACCOUNT,
    "d1_databases": [
        {
            "binding": "DB",
            "database_name": "ai-company-os-staging",
            "database_id": DATABASE_ID,
            "migrations_dir": "../../migrations",
        }
    ],
}
LEDGER_DDL = """CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)"""


def database(count=0, ledger=True):
    """A local stand-in for a D1 database migrated by Wrangler through `count` files."""
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    if ledger and count:
        db.execute(LEDGER_DDL)
    for path in FILES[:count]:
        db.executescript(path.read_text())
        if ledger:
            db.execute("INSERT INTO d1_migrations (name) VALUES (?)", (path.name,))
    db.commit()
    return db


def wrangler_json(rows):
    return [{"results": rows, "success": True, "meta": {}}]


def evidence(db, ledger_names=None):
    tables = {row["name"] for row in pf.sqlite_schema_rows(db)}
    if ledger_names is not None:
        ledger = wrangler_json([{"id": i + 1, "name": n} for i, n in enumerate(ledger_names)])
    elif "d1_migrations" in tables:
        ledger = wrangler_json(
            [{"id": r[0], "name": r[1]} for r in db.execute("SELECT id, name FROM d1_migrations")]
        )
    else:
        ledger = {"absent": True}
    fk_rows = [
        dict(zip(("table", "rowid", "parent", "fkid"), row))
        for row in db.execute("PRAGMA foreign_key_check").fetchall()
    ]
    return {
        "account": {"account_id": ACCOUNT},
        "info": {"uuid": DATABASE_ID, "name": "ai-company-os-staging"},
        "ledger": ledger,
        "schema": wrangler_json(pf.sqlite_schema_rows(db)),
        "foreign_keys": wrangler_json(fk_rows),
    }


def verify(found, target=TARGET, config=CONFIG, manifest=MANIFEST, directory=pf.MIGRATIONS_DIR):
    return pf.verify_d1(target, config, manifest, found, directory)


def reasons(report, gate):
    return report["gates"][gate]["reasons"]


class D1PreflightTests(unittest.TestCase):
    def test_repository_manifest_matches_migration_files(self):
        self.assertEqual(pf.build_manifest(), MANIFEST)
        self.assertEqual(pf.check_plan(pf.MIGRATIONS_DIR, MANIFEST)[0]["status"], "PASS")
        self.assertEqual(NAMES[0][:4], "0001")
        self.assertEqual(int(NAMES[-1][:4]), len(NAMES))

    def test_clean_database_is_empty_staging_not_an_error(self):
        report = verify(evidence(database(0)))
        self.assertEqual(report["result"], "PASS", report["gates"])
        self.assertEqual(report["classification"], "EMPTY_STAGING_DATABASE")
        self.assertEqual(report["pending"], NAMES)
        self.assertFalse(report["remote_commands_executed"])

    def test_0010_upgrade_is_partial_then_full(self):
        db = database(10)
        report = verify(evidence(db))
        self.assertEqual(report["result"], "PASS", report["gates"])
        self.assertEqual(report["classification"], "PARTIALLY_MIGRATED_DATABASE")
        self.assertEqual(report["pending"], NAMES[10:])
        for path in FILES[10:]:
            db.executescript(path.read_text())
            db.execute("INSERT INTO d1_migrations (name) VALUES (?)", (path.name,))
        report = verify(evidence(db))
        self.assertEqual(report["classification"], "FULLY_MIGRATED_DATABASE")
        self.assertEqual(report["result"], "PASS", report["gates"])
        self.assertEqual(report["pending"], [])

    def test_missing_migration_in_ledger_blocks_apply(self):
        db = sqlite3.connect(":memory:")
        db.execute(LEDGER_DDL)
        applied = FILES[:10] + [FILES[11]]
        for path in applied:
            db.executescript(path.read_text())
            db.execute("INSERT INTO d1_migrations (name) VALUES (?)", (path.name,))
        report = verify(evidence(db))
        self.assertFalse(report["apply_allowed"])
        self.assertIn(f"MISSING_MIGRATION:{NAMES[10]}", reasons(report, "STAGING_MIGRATION_LEDGER_VERIFIED"))
        self.assertEqual(report["classification"], "LEDGER_INCONSISTENT")

    def test_duplicate_migrations_are_rejected(self):
        report = verify(evidence(database(3), ledger_names=NAMES[:3] + [NAMES[2]]))
        self.assertIn("DUPLICATE_LEDGER_ENTRY", reasons(report, "STAGING_MIGRATION_LEDGER_VERIFIED"))
        with tempfile.TemporaryDirectory() as tmp:
            for path in FILES:
                shutil.copy(path, tmp)
            shutil.copy(FILES[2], Path(tmp) / "0003_duplicate_copy.sql")
            plan, _ = pf.check_plan(tmp, MANIFEST)
            self.assertIn("DUPLICATE_MIGRATION_NUMBER", plan["reasons"])
            self.assertIn("MIGRATION_UNLISTED:0003_duplicate_copy.sql", plan["reasons"])

    def test_unexpected_schema_is_rejected(self):
        db = database(12)
        db.execute("CREATE TABLE rogue (id TEXT)")
        report = verify(evidence(db))
        self.assertIn("SCHEMA_FINGERPRINT_MISMATCH", reasons(report, "STAGING_MIGRATION_SCHEMA_VERIFIED"))
        self.assertEqual(report["classification"], "UNEXPECTED_SCHEMA")
        # Application tables without a ledger are not an empty staging database.
        unledgered = verify(evidence(database(5, ledger=False)))
        self.assertEqual(unledgered["classification"], "UNEXPECTED_SCHEMA")
        self.assertFalse(unledgered["apply_allowed"])

    def test_wrong_database_identity_is_rejected(self):
        found = evidence(database(0))
        found["info"]["uuid"] = "99999999-2222-4333-8444-555555555555"
        report = verify(found)
        self.assertEqual(report["classification"], "DATABASE_ID_MISMATCH")
        self.assertIn("EVIDENCE_DATABASE_ID_MISMATCH", reasons(report, "STAGING_DB_IDENTITY_VERIFIED"))
        found = evidence(database(0))
        found["account"]["account_id"] = "2" * 32
        self.assertIn("EVIDENCE_ACCOUNT_MISMATCH", reasons(verify(found), "STAGING_DB_IDENTITY_VERIFIED"))
        production_binding = copy.deepcopy(CONFIG)
        production_binding["d1_databases"][0]["database_id"] = "00000000-0000-4000-8000-000000000000"
        report = verify(evidence(database(0)), config=production_binding)
        self.assertEqual(report["classification"], "DATABASE_ID_MISMATCH")
        # A binding with the expected name alone is never enough.
        renamed = copy.deepcopy(CONFIG)
        renamed["name"] = "ai-company-os-api"
        self.assertIn("CONFIG_NOT_STAGING_WORKER", reasons(verify(evidence(database(0)), config=renamed), "STAGING_DB_IDENTITY_VERIFIED"))
        # A target that still holds a placeholder database id is rejected until provisioning.
        placeholder_target = json.loads(pf.TARGET.read_text())
        placeholder_target["database_id"] = "REPLACE_WITH_PROVISIONED_STAGING_D1_UUID"
        placeholder_config = copy.deepcopy(pf.load_jsonc(pf.STAGING_CONFIG))
        placeholder_config["d1_databases"][0]["database_id"] = "REPLACE_WITH_PROVISIONED_STAGING_D1_UUID"
        report = verify(evidence(database(0)), target=placeholder_target, config=placeholder_config)
        self.assertIn("TARGET_DATABASE_ID_UNSET", reasons(report, "STAGING_DB_IDENTITY_VERIFIED"))
        self.assertFalse(report["apply_allowed"])
        # The committed staging config and target agree on the provisioned database id.
        committed_target = json.loads(pf.TARGET.read_text())
        committed_config = pf.load_jsonc(pf.STAGING_CONFIG)
        self.assertEqual(committed_target["database_id"], committed_config["d1_databases"][0]["database_id"])
        self.assertNotIn("REPLACE_WITH", committed_target["database_id"])

    def test_modified_historical_migration_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for path in FILES:
                shutil.copy(path, tmp)
            edited = Path(tmp) / NAMES[4]
            edited.write_text(edited.read_text() + "\n-- edited after merge\n")
            report = verify(evidence(database(0)), directory=tmp)
            self.assertIn(f"MIGRATION_MODIFIED:{NAMES[4]}", reasons(report, "STAGING_MIGRATION_PLAN_VERIFIED"))
            self.assertFalse(report["apply_allowed"])

    def test_failed_migration_is_detected_unless_rolled_back(self):
        db = database(12)
        statements = [s for s in FILES[12].read_text().split(";") if s.strip()]
        # Non-atomic partial execution leaves drift that the ledger does not record.
        for statement in statements[:3]:
            db.execute(statement)
        report = verify(evidence(db))
        self.assertIn("SCHEMA_FINGERPRINT_MISMATCH", reasons(report, "STAGING_MIGRATION_SCHEMA_VERIFIED"))

        rolled_back = database(12)
        rolled_back.isolation_level = None
        rolled_back.execute("BEGIN")
        with self.assertRaises(sqlite3.OperationalError):
            for statement in statements[:6]:
                rolled_back.execute(statement)
            rolled_back.execute("SELECT * FROM table_that_does_not_exist")
        rolled_back.execute("ROLLBACK")
        report = verify(evidence(rolled_back))
        self.assertEqual(report["result"], "PASS", report["gates"])
        self.assertEqual(report["pending"], NAMES[12:])

    def test_foreign_key_violation_is_rejected(self):
        db = database(len(FILES))
        db.execute("PRAGMA foreign_keys = OFF")
        db.execute(
            "INSERT INTO organizations VALUES ('org_orphan', 'Orphan', 'active', 'usr_missing', 'now', 'now')"
        )
        report = verify(evidence(db))
        self.assertIn("FOREIGN_KEY_VIOLATION", reasons(report, "STAGING_MIGRATION_SCHEMA_VERIFIED"))
        self.assertFalse(report["apply_allowed"])

    def test_missing_evidence_fails_closed(self):
        found = evidence(database(0))
        del found["ledger"]
        del found["foreign_keys"]
        report = verify(found)
        self.assertIn("LEDGER_EVIDENCE_MISSING", reasons(report, "STAGING_MIGRATION_LEDGER_VERIFIED"))
        self.assertIn("FOREIGN_KEY_EVIDENCE_MISSING", reasons(report, "STAGING_MIGRATION_SCHEMA_VERIFIED"))
        # An empty database must be proven empty; absent schema evidence is not emptiness.
        found = evidence(database(0))
        del found["schema"]
        report = verify(found)
        self.assertIn("SCHEMA_EVIDENCE_MISSING", reasons(report, "STAGING_MIGRATION_SCHEMA_VERIFIED"))
        self.assertFalse(report["apply_allowed"])
        found = evidence(database(0))
        del found["info"]
        self.assertFalse(verify(found)["apply_allowed"])


class StagingConfigTests(unittest.TestCase):
    def setUp(self):
        self.base = pf.load_jsonc(pf.BASE_CONFIG)
        self.staging = pf.load_jsonc(pf.STAGING_CONFIG)
        self.target = json.loads(pf.TARGET.read_text())
        self.entry = pf.WORKER_ENTRY.read_text()

    def check(self, staging):
        return pf.check_staging_config(self.base, staging, self.target, self.entry)

    def test_repository_staging_config_passes_static_gates(self):
        report = self.check(self.staging)
        self.assertEqual(report["result"], "PASS", report["gates"])
        self.assertTrue(report["DO_REMOTE_PROVISIONING_NOT_PERFORMED"])
        # Access provisioned 2026-10-10 (ROOMAGENT_STAGING_ACCESS_AND_DEPLOY_CONFIG_V1):
        # ACCESS_TEAM_DOMAIN / ACCESS_AUD now hold verified values, so the config
        # is legitimately deploy-ready. The old placeholder assertions below are kept
        # as a guard for the pre-provisioning state via test_placeholders_block_deploy_ready.
        self.assertTrue(report["deploy_ready"])
        self.assertEqual(report["unprovisioned_placeholders"], [])

    def test_placeholders_block_deploy_ready(self):
        # Safety guard: a staging config that still carries REPLACE_WITH_*
        # placeholders must NOT be considered deploy-ready.
        staging = copy.deepcopy(self.staging)
        staging["vars"]["ACCESS_TEAM_DOMAIN"] = "REPLACE_WITH_ACCESS_TEAM_DOMAIN"
        staging["vars"]["ACCESS_AUD"] = "REPLACE_WITH_ACCESS_APPLICATION_AUD"
        report = self.check(staging)
        self.assertFalse(report["deploy_ready"])
        self.assertEqual(
            report["unprovisioned_placeholders"],
            ["var:ACCESS_TEAM_DOMAIN", "var:ACCESS_AUD"],
        )

    def test_reusing_a_base_resource_is_rejected(self):
        staging = copy.deepcopy(self.staging)
        staging["queues"]["producers"][0]["queue"] = self.base["queues"]["producers"][0]["queue"]
        report = self.check(staging)
        self.assertEqual(report["gates"]["STAGING_CONFIG_ISOLATED"]["status"], "FAIL")

    def test_legacy_migrations_or_non_sqlite_classes_are_rejected(self):
        staging = copy.deepcopy(self.staging)
        staging["migrations"] = [{"tag": "v1", "new_sqlite_classes": ["OrganizationDO"]}]
        staging["exports"]["RoomDO"] = {"type": "durable-object"}
        report = self.check(staging)
        gate = report["gates"]["DO_CLASSES_VALIDATED_LOCALLY"]["reasons"]
        self.assertIn("LEGACY_MIGRATIONS_WITH_EXPORTS", gate)
        self.assertIn("DO_CLASS_NOT_SQLITE_EXPORT:RoomDO", gate)

    def test_binding_drift_and_zero_retry_delay_are_rejected(self):
        staging = copy.deepcopy(self.staging)
        staging["durable_objects"]["bindings"][0]["name"] = "ORG"
        staging["queues"]["consumers"][0]["retry_delay"] = 0
        gate = self.check(staging)["gates"]["DO_BINDINGS_VALIDATED_LOCALLY"]["reasons"]
        self.assertIn("STAGING_BINDINGS_DIFFER_FROM_BASE", gate)
        self.assertIn("QUEUE_RETRY_WITHOUT_DELAY:ai-company-os-staging-domain-events", gate)

    def test_jsonc_parser_keeps_strings_with_comment_markers(self):
        parsed = json.loads(pf.strip_jsonc('{"a": "https://x//y", /* c */ "b": [1, 2,], // d\n}'))
        self.assertEqual(parsed, {"a": "https://x//y", "b": [1, 2]})


if __name__ == "__main__":
    unittest.main()
