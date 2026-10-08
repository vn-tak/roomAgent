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
            db.commit()
            apply(db, upgrades)
            self.assertEqual(db.execute(
                "SELECT name FROM organizations WHERE id = 'org_existing'"
            ).fetchone(), ("Existing organization",))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main()
