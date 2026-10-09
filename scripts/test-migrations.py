"""Exercise fresh installs and forward upgrades without any remote database."""
import hashlib
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import d1_preflight as preflight  # noqa: E402

MIGRATIONS = sorted((Path(__file__).resolve().parent.parent / "migrations").glob("*.sql"))
BEFORE_0013 = [m for m in MIGRATIONS if int(m.name[:4]) < 13]
FROM_0013 = [m for m in MIGRATIONS if int(m.name[:4]) >= 13]
PRESERVED_TABLES = (
    "organizations", "tasks", "artifacts", "artifact_versions", "reviews", "approvals",
    "workflow_runs",
)


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    return db


def apply(db, migrations):
    for migration in migrations:
        db.executescript(migration.read_text())


TASK_ID = "task_" + "1" * 32


def populate_0010(db):
    """Representative pre-0011 production data, including governance evidence."""
    db.execute("INSERT INTO human_users VALUES ('usr_existing', 'Owner', '2026-10-08')")
    db.execute("""INSERT INTO organizations VALUES
        ('org_existing', 'Existing organization', 'active', 'usr_existing',
         '2026-10-08', '2026-10-08')""")
    db.execute("""INSERT INTO tasks
        (id, org_id, title, objective, state, creator_type, creator_id,
         assignee_id, room_id, handoff_count, human_review_required,
         pause_reason, version, created_at, updated_at)
        VALUES (?, 'org_existing', 'Legacy', 'Keep this task', 'CREATED',
                'human', 'usr_existing', NULL, NULL, 0, 0, NULL, 1,
                '2026-10-08', '2026-10-08')""", (TASK_ID,))
    db.execute("""INSERT INTO rooms VALUES
        ('room_existing', 'org_existing', 'Existing room', NULL, 'active', '2026-10-08')""")
    db.execute("""INSERT INTO employees VALUES
        ('emp_existing', 'org_existing', 'Worker', 'active', '2026-10-08', '2026-10-08')""")
    db.execute("UPDATE tasks SET room_id = 'room_existing' WHERE id = ?", (TASK_ID,))
    db.execute("""INSERT INTO artifacts VALUES
        ('art_existing', 'org_existing', 'room_existing', ?, 'employee', 'emp_existing',
         1, '2026-10-08', '2026-10-08')""", (TASK_ID,))
    db.execute("""INSERT INTO artifact_versions VALUES
        ('org_existing', 'art_existing', 1,
         'org/org_existing/project/room_existing/artifact/art_existing/v1',
         ?, 'text/plain', 1, NULL, '2026-10-08')""", ("1" * 64,))
    db.execute("""INSERT INTO reviews VALUES
        ('rev_existing', 'org_existing', 'art_existing', 1, 'human', 'usr_existing',
         'PASS', 1, 'legacy_review_001', '2026-10-08')""")
    db.execute("""INSERT INTO approvals VALUES
        ('apr_existing', 'org_existing', 'art_existing', 1, 'final', 'human',
         'usr_existing', 'PASS', 'ALLOWED', 1, 'legacy_approval_001', '2026-10-08')""")
    db.execute("""INSERT INTO workflow_runs VALUES
        ('wfr_existing', 'org_existing', 'wfr_existing', ?, 'art_existing', 1,
         'complete', 'complete', 0, '2026-10-08', '2026-10-08')""", (TASK_ID,))
    db.commit()


def table_columns(db):
    return {t: [c[1] for c in db.execute(f"PRAGMA table_info({t})")] for t in PRESERVED_TABLES}


def table_digest(db, columns):
    """Digest of pre-existing columns; later forward migrations may only add columns."""
    digest = {}
    for table, names in columns.items():
        rows = db.execute(f"SELECT {', '.join(names)} FROM {table}").fetchall()
        text = "\n".join(sorted(repr(row) for row in rows))
        digest[table] = (len(rows), hashlib.sha256(text.encode()).hexdigest())
    return digest


def schema_fingerprint(db):
    return preflight.fingerprint(preflight.schema_entries(preflight.sqlite_schema_rows(db)))


def assert_guards(test, db):
    """Tenant, immutability, and FK guards that 0013 must restore after its table rebuild."""
    for statement, message in (
        ("UPDATE artifact_versions SET size = 2 WHERE version = 1", "ARTIFACT_IMMUTABLE"),
        ("DELETE FROM artifact_versions WHERE version = 1", "ARTIFACT_IMMUTABLE"),
        ("""INSERT INTO artifact_versions VALUES ('org_existing', 'art_existing', 9,
            'wrong/key', '""" + "9" * 64 + """', 'text/plain', 1, NULL, 'now')""", "TENANT_MISMATCH"),
        ("""INSERT INTO reviews VALUES ('rev_cross', 'org_other', 'art_existing', 1, 'human',
            'usr_existing', 'PASS', 1, 'cross_review_0001', 'now')""", "TENANT_MISMATCH"),
        ("""INSERT INTO approvals VALUES ('apr_cross', 'org_existing', 'art_existing', 7, 'final',
            'human', 'usr_existing', 'PASS', 'ALLOWED', 1, 'cross_approval_01', 'now')""", "TENANT_MISMATCH"),
        ("DELETE FROM workflow_runs", "WORKFLOW_IMMUTABLE"),
    ):
        with test.assertRaisesRegex(sqlite3.IntegrityError, message):
            db.execute(statement)
    test.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])


class MigrationTests(unittest.TestCase):
    def test_fresh_schema(self):
        with database() as db:
            apply(db, MIGRATIONS)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertIsNotNone(db.execute(
                "SELECT name FROM sqlite_master WHERE name = 'artifacts_task_room_integrity'"
            ).fetchone())
            self.assertIsNotNone(db.execute(
                "SELECT name FROM sqlite_master WHERE name = 'human_sessions'"
            ).fetchone())

    def test_upgrade_preserves_existing_data(self):
        with database() as db:
            historical = [m for m in MIGRATIONS if int(m.name[:4]) <= 10]
            upgrades = [m for m in MIGRATIONS if int(m.name[:4]) > 10]
            apply(db, historical)
            populate_0010(db)
            task_id = TASK_ID
            apply(db, upgrades)
            self.assertEqual(db.execute("SELECT size FROM artifact_versions").fetchall(), [(1,)])
            self.assertEqual(db.execute("SELECT result FROM reviews").fetchall(), [("PASS",)])
            self.assertEqual(db.execute("SELECT decision FROM approvals").fetchall(), [("PASS",)])
            db.execute("""INSERT INTO artifact_versions VALUES
                ('org_existing', 'art_existing', 2,
                 'org/org_existing/project/room_existing/artifact/art_existing/v2',
                 ?, 'video/mp4', 1048577, NULL, '2026-10-08')""", ("2" * 64,))
            with self.assertRaisesRegex(sqlite3.IntegrityError, "ARTIFACT_IMMUTABLE"):
                db.execute("UPDATE artifact_versions SET size = 2 WHERE version = 1")
            with self.assertRaisesRegex(sqlite3.IntegrityError, "ARTIFACT_IMMUTABLE"):
                db.execute("DELETE FROM artifact_versions WHERE version = 1")
            with self.assertRaisesRegex(sqlite3.IntegrityError, "TENANT_MISMATCH"):
                db.execute("""INSERT INTO artifact_versions VALUES
                    ('org_existing', 'art_existing', 3, 'wrong/key', ?,
                     'text/plain', 1, NULL, '2026-10-08')""", ("3" * 64,))
            with self.assertRaisesRegex(sqlite3.IntegrityError, "ROOM_MISMATCH"):
                db.execute("""INSERT INTO artifacts VALUES
                    ('art_wrong_room', 'org_existing', 'room_missing', ?, 'employee',
                     'emp_existing', 1, '2026-10-08', '2026-10-08')""", (task_id,))
            self.assertEqual(db.execute(
                "SELECT completion_policy, correlation_id FROM tasks WHERE id = ?",
                (task_id,)
            ).fetchone(), ("NONE", "corr_" + "1" * 32))
            self.assertEqual(db.execute(
                "SELECT name FROM organizations WHERE id = 'org_existing'"
            ).fetchone(), ("Existing organization",))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])


class Migration0013RecoveryTests(unittest.TestCase):
    """Offline model of the 0013 runbook. A SQLite backup stands in for a D1 Time Travel
    bookmark; it does not certify remote D1 restore behaviour."""

    def migrated_to_0012(self):
        db = database()
        apply(db, [m for m in MIGRATIONS if int(m.name[:4]) <= 10])
        populate_0010(db)
        apply(db, [m for m in BEFORE_0013 if int(m.name[:4]) > 10])
        return db

    def test_populated_0010_to_latest_preserves_data_and_guards(self):
        db = self.migrated_to_0012()
        columns = table_columns(db)
        before = table_digest(db, columns)
        apply(db, FROM_0013)
        self.assertEqual(table_digest(db, columns), before)
        self.assertEqual(schema_fingerprint(db), preflight.expected_fingerprints(MIGRATIONS)[-1])
        assert_guards(self, db)

    def test_restore_checkpoint_returns_exact_pre_0013_state(self):
        db = self.migrated_to_0012()
        columns = table_columns(db)
        before_data = table_digest(db, columns)
        before_schema = schema_fingerprint(db)
        self.assertEqual(before_schema, preflight.expected_fingerprints(MIGRATIONS)[12])
        checkpoint = sqlite3.connect(":memory:")
        db.backup(checkpoint)

        apply(db, FROM_0013)
        db.execute("""INSERT INTO artifact_versions VALUES
            ('org_existing', 'art_existing', 2,
             'org/org_existing/project/room_existing/artifact/art_existing/v2',
             ?, 'video/mp4', 1048577, NULL, '2026-10-09')""", ("2" * 64,))
        db.commit()

        # Database restore, not code rollback: writes after the checkpoint are lost.
        checkpoint.backup(db)
        self.assertEqual(schema_fingerprint(db), before_schema)
        self.assertEqual(table_columns(db), columns)
        self.assertEqual(table_digest(db, columns), before_data)
        self.assertEqual(db.execute(
            "SELECT COUNT(*) FROM artifact_versions WHERE version = 2").fetchone(), (0,))

        # The restored database is a clean 0012 state that can be migrated forward again.
        apply(db, FROM_0013)
        self.assertEqual(table_digest(db, columns), before_data)
        assert_guards(self, db)

    def test_failed_0013_rolls_back_atomically(self):
        db = self.migrated_to_0012()
        columns = table_columns(db)
        before_data = table_digest(db, columns)
        before_schema = schema_fingerprint(db)
        db.isolation_level = None
        db.execute("BEGIN")
        statements = [s for s in FROM_0013[0].read_text().split(";") if s.strip()]
        with self.assertRaises(sqlite3.OperationalError):
            for statement in statements[:6]:
                db.execute(statement)
            db.execute("SELECT simulated_failure FROM artifact_versions")
        db.execute("ROLLBACK")
        self.assertEqual(schema_fingerprint(db), before_schema)
        self.assertEqual(table_digest(db, columns), before_data)
        self.assertIsNotNone(db.execute(
            "SELECT name FROM sqlite_master WHERE name = 'reviews_same_org'").fetchone())


class WorkflowHoldPolicyTests(unittest.TestCase):
    """Database-level enforcement of the 0015 hold/release policy, independent of the API."""

    def setUp(self):
        self.db = database()
        apply(self.db, [m for m in MIGRATIONS if int(m.name[:4]) <= 10])
        populate_0010(self.db)
        apply(self.db, [m for m in MIGRATIONS if int(m.name[:4]) > 10])
        self.serial = 0

    def tearDown(self):
        self.db.close()

    def run_with_claim(self, status="running", reason=None, iteration=0, actor=("human", "usr_existing")):
        self.serial += 1
        run_id = "wfr_" + format(self.serial, "032x")
        self.db.execute("""INSERT INTO workflow_start_claims VALUES
            (?, 'org_existing', ?, 'art_existing', 1, ?, ?, ?, 'claimed', NULL, 'now', 'now')""",
            (run_id, TASK_ID, actor[0], actor[1], f"key_{self.serial:08d}"))
        self.db.execute("UPDATE workflow_start_claims SET state = 'created' WHERE id = ?", (run_id,))
        self.db.execute("""INSERT INTO workflow_runs
            (id, org_id, instance_id, task_id, artifact_id, artifact_version, status, stage,
             iteration, created_at, updated_at)
            VALUES (?, 'org_existing', ?, ?, 'art_existing', 1, 'running', 'qa_review', 0, 'now', 'now')""",
            (run_id, run_id, TASK_ID))
        if status != "running":
            self.db.execute(
                "UPDATE workflow_runs SET status = ?, hold_reason = ?, iteration = ? WHERE id = ?",
                (status, reason, iteration, run_id))
        return run_id

    def release(self, run_id, reason):
        self.db.execute(
            "UPDATE workflow_start_claims SET state = 'released', release_reason = ? WHERE id = ?",
            (reason, run_id))

    def resolve(self, run_id, reason, policy, actor_type="human", actor_id="usr_existing"):
        self.serial += 1
        self.db.execute("""INSERT INTO workflow_run_resolutions VALUES
            (?, 'org_existing', ?, ?, ?, ?, ?, ?, ?, 'now')""",
            (f"evt_{self.serial}", run_id, TASK_ID, reason, policy, actor_type, actor_id,
             f"resolve_{self.serial:06d}"))

    def test_held_runs_need_a_matching_resolution(self):
        run_id = self.run_with_claim("paused", "LOOP_GUARD", 8)
        for reason in ("completed", "never_registered", "instance_failed", "resolved"):
            with self.assertRaisesRegex(sqlite3.IntegrityError, "WORKFLOW_RELEASE_DENIED"):
                self.release(run_id, reason)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RESOLUTION_POLICY"):
            self.resolve(run_id, "LOOP_GUARD", "workflow_approver")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RESOLUTION_POLICY"):
            self.resolve(run_id, "LOOP_GUARD", "owner_human", "employee", "emp_existing")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "WORKFLOW_NOT_HELD"):
            self.resolve(run_id, "TIMEOUT", "workflow_approver")
        self.resolve(run_id, "LOOP_GUARD", "owner_human")
        self.release(run_id, "resolved")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "WORKFLOW_IMMUTABLE"):
            self.db.execute("UPDATE workflow_runs SET status = 'running', hold_reason = NULL WHERE id = ?", (run_id,))

    def test_run_holds_are_final_and_carry_a_reason(self):
        run_id = self.run_with_claim()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "WORKFLOW_HOLD_REASON"):
            self.db.execute("UPDATE workflow_runs SET status = 'paused' WHERE id = ?", (run_id,))
        self.db.execute(
            "UPDATE workflow_runs SET status = 'paused', hold_reason = 'TIMEOUT' WHERE id = ?", (run_id,))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "WORKFLOW_IMMUTABLE"):
            self.db.execute("UPDATE workflow_runs SET hold_reason = 'INSTANCE_FAILED' WHERE id = ?", (run_id,))

    def test_starter_cannot_resolve_their_own_run(self):
        run_id = self.run_with_claim("paused", "TIMEOUT", actor=("employee", "emp_existing"))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RESOLUTION_POLICY"):
            self.resolve(run_id, "TIMEOUT", "workflow_approver", "employee", "emp_existing")

    def test_automatic_recovery_is_limited(self):
        progressed = self.run_with_claim("paused", "INSTANCE_FAILED", 1)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "WORKFLOW_RELEASE_DENIED"):
            self.release(progressed, "instance_failed")
        self.resolve(progressed, "INSTANCE_FAILED", "workflow_approver")
        self.release(progressed, "resolved")
        for _ in range(2):
            self.release(self.run_with_claim("paused", "INSTANCE_FAILED", 0), "instance_failed")
        third = self.run_with_claim("paused", "INSTANCE_FAILED", 0)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "WORKFLOW_RELEASE_DENIED"):
            self.release(third, "instance_failed")

    def test_resolution_budget_per_task(self):
        for _ in range(3):
            run_id = self.run_with_claim("paused", "TIMEOUT")
            self.resolve(run_id, "TIMEOUT", "workflow_approver")
            self.release(run_id, "resolved")
        fourth = self.run_with_claim("paused", "TIMEOUT")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RESOLUTION_BUDGET_EXHAUSTED"):
            self.resolve(fourth, "TIMEOUT", "workflow_approver")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "AUDIT_IMMUTABLE"):
            self.db.execute("DELETE FROM workflow_run_resolutions")

    def test_human_identity_requires_provisioned_subject(self):
        insert = """INSERT INTO human_identities
            (id, issuer, email, subject, user_id, attestation_ref, status, created_at, updated_at)
            VALUES (?, 'https://team.cloudflareaccess.com', ?, ?, 'usr_existing', ?, 'active', 'now', 'now')"""
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("hid_" + "1" * 32, "a@b.test", None, "CHANGE-0001"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("hid_" + "2" * 32, "a@b.test", "sub-a", None))
        self.db.execute(insert, ("hid_" + "3" * 32, "a@b.test", "sub-a", "CHANGE-0001"))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "IDENTITY_IMMUTABLE"):
            self.db.execute("UPDATE human_identities SET subject = 'sub-b'")
        self.db.execute("UPDATE human_identities SET status = 'disabled'")


if __name__ == "__main__":
    unittest.main()
