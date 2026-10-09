"""Exercise fresh installs and forward upgrades without any remote database."""
import sqlite3
import unittest
from pathlib import Path

MIGRATIONS = sorted((Path(__file__).resolve().parent.parent / "migrations").glob("*.sql"))


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    return db


def apply(db, migrations):
    for migration in migrations:
        db.executescript(migration.read_text())


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
            db.execute("INSERT INTO human_users VALUES ('usr_existing', 'Owner', '2026-10-08')")
            db.execute("""INSERT INTO organizations VALUES
                ('org_existing', 'Existing organization', 'active', 'usr_existing',
                 '2026-10-08', '2026-10-08')""")
            task_id = "task_" + "1" * 32
            db.execute("""INSERT INTO tasks
                (id, org_id, title, objective, state, creator_type, creator_id,
                 assignee_id, room_id, handoff_count, human_review_required,
                 pause_reason, version, created_at, updated_at)
                VALUES (?, 'org_existing', 'Legacy', 'Keep this task', 'CREATED',
                        'human', 'usr_existing', NULL, NULL, 0, 0, NULL, 1,
                        '2026-10-08', '2026-10-08')""", (task_id,))
            db.execute("""INSERT INTO rooms VALUES
                ('room_existing', 'org_existing', 'Existing room', NULL, 'active', '2026-10-08')""")
            db.execute("""INSERT INTO employees VALUES
                ('emp_existing', 'org_existing', 'Worker', 'active', '2026-10-08', '2026-10-08')""")
            db.execute("UPDATE tasks SET room_id = 'room_existing' WHERE id = ?", (task_id,))
            db.execute("""INSERT INTO artifacts VALUES
                ('art_existing', 'org_existing', 'room_existing', ?, 'employee', 'emp_existing',
                 1, '2026-10-08', '2026-10-08')""", (task_id,))
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
            db.commit()
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


if __name__ == "__main__":
    unittest.main()
