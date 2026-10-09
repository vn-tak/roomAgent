"""Offline staging preflight for RoomAgent D1 migrations and Wrangler configuration.

This tool never contacts Cloudflare. Remote facts arrive as JSON evidence files captured
by an operator with read-only commands (see docs/reports/ROOMAGENT_D1_MIGRATION_PREFLIGHT.md).
Every gate is machine-readable; migrations may be applied only when all gates PASS.
"""

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = ROOT / "migrations"
MANIFEST = ROOT / "deploy" / "d1" / "migrations.manifest.json"
TARGET = ROOT / "deploy" / "staging" / "d1-target.json"
BASE_CONFIG = ROOT / "apps" / "api" / "wrangler.jsonc"
STAGING_CONFIG = ROOT / "apps" / "api" / "wrangler.staging.jsonc"
WORKER_ENTRY = ROOT / "apps" / "api" / "src" / "index.ts"

MIGRATION_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
ACCOUNT_ID = re.compile(r"^[0-9a-f]{32}$")
DATABASE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PLACEHOLDER = re.compile(r"REPLACE|PLACEHOLDER|TODO|^0{8}-", re.IGNORECASE)
INTERNAL_PREFIXES = ("sqlite_", "_cf_")
LEDGER_TABLE = "d1_migrations"
D1_GATES = (
    "STAGING_DB_IDENTITY_VERIFIED",
    "STAGING_MIGRATION_PLAN_VERIFIED",
    "STAGING_MIGRATION_LEDGER_VERIFIED",
    "STAGING_MIGRATION_SCHEMA_VERIFIED",
)


# ---------------------------------------------------------------- helpers


def strip_jsonc(text):
    """Remove // and /* */ comments outside strings, then trailing commas."""
    out, i, in_string = [], 0, False
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\":
                out.append(text[i + 1])
                i += 1
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
            out.append(ch)
        elif text.startswith("//", i):
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            i = text.index("*/", i) + 2
            continue
        else:
            out.append(ch)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load_jsonc(path):
    return json.loads(strip_jsonc(Path(path).read_text()))


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def migration_files(directory=MIGRATIONS_DIR):
    return sorted(Path(directory).glob("*.sql"))


def build_manifest(directory=MIGRATIONS_DIR):
    return {
        "format": 1,
        "migrations": [
            {"name": path.name, "sha256": sha256_file(path)} for path in migration_files(directory)
        ],
    }


def rows_of(evidence):
    """Accept `wrangler d1 execute --json` output, a {results: [...]} object, or a row list."""
    if isinstance(evidence, dict) and "results" in evidence:
        return list(evidence["results"])
    if isinstance(evidence, list) and evidence and isinstance(evidence[0], dict):
        if "results" in evidence[0]:
            rows = []
            for statement in evidence:
                if statement.get("success") is False:
                    raise ValueError("evidence statement did not succeed")
                rows.extend(statement.get("results") or [])
            return rows
    if isinstance(evidence, list):
        return list(evidence)
    raise ValueError("unrecognized evidence shape")


def schema_entries(rows):
    entries = []
    for row in rows:
        name = row.get("name") or ""
        table = row.get("tbl_name") or ""
        if name == LEDGER_TABLE or table == LEDGER_TABLE:
            continue
        if any(name.startswith(p) or table.startswith(p) for p in INTERNAL_PREFIXES):
            continue
        sql = " ".join((row.get("sql") or "").split())
        entries.append([row.get("type") or "", name, table, sql])
    return sorted(entries)


def fingerprint(entries):
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def sqlite_schema_rows(db):
    cursor = db.execute("SELECT type, name, tbl_name, sql FROM sqlite_master")
    return [dict(zip(("type", "name", "tbl_name", "sql"), row)) for row in cursor.fetchall()]


def expected_fingerprints(files):
    """Fingerprint after applying the first k migrations, for k = 0..len(files)."""
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    prints = [fingerprint(schema_entries(sqlite_schema_rows(db)))]
    for path in files:
        db.executescript(Path(path).read_text())
        prints.append(fingerprint(schema_entries(sqlite_schema_rows(db))))
    db.close()
    return prints


def gate(reasons):
    return {"status": "PASS" if not reasons else "FAIL", "reasons": reasons}


def is_placeholder(value):
    return not isinstance(value, str) or not value or bool(PLACEHOLDER.search(value))


# ---------------------------------------------------------------- D1 gates


def check_plan(directory, manifest):
    files = migration_files(directory)
    reasons = []
    numbers = []
    for path in files:
        match = MIGRATION_NAME.match(path.name)
        if not match:
            reasons.append(f"MIGRATION_NAME_INVALID:{path.name}")
            continue
        numbers.append(int(match.group(1)))
    if len(numbers) != len(set(numbers)):
        reasons.append("DUPLICATE_MIGRATION_NUMBER")
    if sorted(numbers) != list(range(1, len(numbers) + 1)):
        reasons.append("MIGRATION_SEQUENCE_NOT_CONTIGUOUS")
    listed = [entry.get("name") for entry in manifest.get("migrations", [])]
    if len(listed) != len(set(listed)):
        reasons.append("DUPLICATE_MANIFEST_ENTRY")
    on_disk = {path.name: path for path in files}
    for entry in manifest.get("migrations", []):
        path = on_disk.get(entry.get("name"))
        if path is None:
            reasons.append(f"MIGRATION_FILE_MISSING:{entry.get('name')}")
        elif sha256_file(path) != entry.get("sha256"):
            reasons.append(f"MIGRATION_MODIFIED:{path.name}")
    for name in on_disk:
        if name not in listed:
            reasons.append(f"MIGRATION_UNLISTED:{name}")
    if [p.name for p in files] != listed and not any(
        r.startswith(("MIGRATION_UNLISTED", "MIGRATION_FILE_MISSING")) for r in reasons
    ):
        reasons.append("MIGRATION_ORDER_MISMATCH")
    return gate(reasons), [on_disk[name] for name in listed if name in on_disk]


def check_identity(target, config, evidence):
    reasons = []
    mismatch = False
    if target.get("environment") != "staging":
        reasons.append("TARGET_ENVIRONMENT_NOT_STAGING")
    account = target.get("account_id")
    database_id = target.get("database_id")
    database_name = target.get("database_name")
    if is_placeholder(account) or not ACCOUNT_ID.match(account or ""):
        reasons.append("TARGET_ACCOUNT_ID_UNSET")
    if is_placeholder(database_id) or not DATABASE_ID.match(database_id or ""):
        reasons.append("TARGET_DATABASE_ID_UNSET")
    if is_placeholder(database_name):
        reasons.append("TARGET_DATABASE_NAME_UNSET")

    if not str(config.get("name", "")).endswith("-staging"):
        reasons.append("CONFIG_NOT_STAGING_WORKER")
    if config.get("account_id") != account:
        reasons.append("CONFIG_ACCOUNT_MISMATCH")
    bindings = [d for d in config.get("d1_databases", []) if d.get("binding") == target.get("binding")]
    if len(bindings) != 1:
        reasons.append("CONFIG_D1_BINDING_MISSING")
    else:
        binding = bindings[0]
        if binding.get("database_id") != database_id:
            reasons.append("CONFIG_DATABASE_ID_MISMATCH")
            mismatch = True
        if binding.get("database_name") != database_name:
            reasons.append("CONFIG_DATABASE_NAME_MISMATCH")
        migrations_dir = (STAGING_CONFIG.parent / binding.get("migrations_dir", "")).resolve()
        if migrations_dir != MIGRATIONS_DIR.resolve():
            reasons.append("CONFIG_MIGRATIONS_DIR_MISMATCH")

    observed_account = (evidence.get("account") or {}).get("account_id")
    if observed_account != account:
        reasons.append("EVIDENCE_ACCOUNT_MISMATCH")
    info = evidence.get("info") or {}
    if info.get("uuid") != database_id:
        reasons.append("EVIDENCE_DATABASE_ID_MISMATCH")
        mismatch = True
    if info.get("name") != database_name:
        reasons.append("EVIDENCE_DATABASE_NAME_MISMATCH")
    return gate(reasons), mismatch


def check_ledger(listed_names, evidence, schema_rows):
    ledger = evidence.get("ledger")
    reasons = []
    has_table = any((row.get("name") == LEDGER_TABLE) for row in schema_rows)
    if ledger is None:
        return gate(["LEDGER_EVIDENCE_MISSING"]), None
    if isinstance(ledger, dict) and ledger.get("absent") is True:
        if has_table:
            reasons.append("LEDGER_ABSENT_BUT_TABLE_EXISTS")
        applied = []
    else:
        rows = sorted(rows_of(ledger), key=lambda row: row.get("id", 0))
        applied = [row.get("name") for row in rows]
        if not has_table:
            reasons.append("LEDGER_TABLE_NOT_IN_SCHEMA")
    if len(applied) != len(set(applied)):
        reasons.append("DUPLICATE_LEDGER_ENTRY")
    for name in applied:
        if name not in listed_names:
            reasons.append(f"UNKNOWN_MIGRATION_IN_LEDGER:{name}")
    for index, name in enumerate(applied):
        if index >= len(listed_names) or listed_names[index] != name:
            missing = [n for n in listed_names[: listed_names.index(name)] if n not in applied] if name in listed_names else []
            reasons.append(
                f"MISSING_MIGRATION:{missing[0]}" if missing else f"LEDGER_ORDER_MISMATCH:{name}"
            )
            break
    return gate(reasons), applied


def classify(identity_mismatch, applied, total, gates):
    if identity_mismatch:
        return "DATABASE_ID_MISMATCH"
    if gates["STAGING_MIGRATION_LEDGER_VERIFIED"]["status"] == "FAIL" or applied is None:
        return "LEDGER_INCONSISTENT"
    if gates["STAGING_MIGRATION_SCHEMA_VERIFIED"]["status"] == "FAIL":
        return "UNEXPECTED_SCHEMA"
    if not applied:
        return "EMPTY_STAGING_DATABASE"
    if len(applied) < total:
        return "PARTIALLY_MIGRATED_DATABASE"
    return "FULLY_MIGRATED_DATABASE"


def verify_d1(target, config, manifest, evidence, directory=MIGRATIONS_DIR):
    plan_gate, files = check_plan(directory, manifest)
    names = [path.name for path in files]
    identity_gate, mismatch = check_identity(target, config, evidence)
    schema_missing = evidence.get("schema") is None
    schema_rows = [] if schema_missing else rows_of(evidence["schema"])
    ledger_gate, applied = check_ledger(names, evidence, schema_rows)

    schema_reasons = ["SCHEMA_EVIDENCE_MISSING"] if schema_missing else []
    actual = fingerprint(schema_entries(schema_rows))
    expected = None
    if schema_missing:
        pass
    elif applied is not None and ledger_gate["status"] == "PASS" and plan_gate["status"] == "PASS":
        expected = expected_fingerprints(files)[len(applied)]
        if actual != expected:
            schema_reasons.append("SCHEMA_FINGERPRINT_MISMATCH")
    else:
        schema_reasons.append("SCHEMA_NOT_COMPARABLE")
    if evidence.get("foreign_keys") is None:
        schema_reasons.append("FOREIGN_KEY_EVIDENCE_MISSING")
    elif rows_of(evidence["foreign_keys"]):
        schema_reasons.append("FOREIGN_KEY_VIOLATION")

    gates = {
        "STAGING_DB_IDENTITY_VERIFIED": identity_gate,
        "STAGING_MIGRATION_PLAN_VERIFIED": plan_gate,
        "STAGING_MIGRATION_LEDGER_VERIFIED": ledger_gate,
        "STAGING_MIGRATION_SCHEMA_VERIFIED": gate(schema_reasons),
    }
    passed = all(g["status"] == "PASS" for g in gates.values())
    return {
        "tool": "roomagent-d1-preflight",
        "format": 1,
        "environment": target.get("environment"),
        "classification": classify(mismatch, applied, len(names), gates),
        "applied": applied,
        "pending": [n for n in names if applied is not None and n not in applied],
        "expected_schema_fingerprint": expected,
        "actual_schema_fingerprint": actual,
        "gates": gates,
        "result": "PASS" if passed else "FAIL",
        "apply_allowed": passed,
        "remote_commands_executed": False,
    }


# ---------------------------------------------------------------- Wrangler config gates


def resource_names(config):
    names = {
        "worker": config.get("name"),
        "workflows": sorted(w.get("name") for w in config.get("workflows", [])),
        "queues": sorted(
            {q.get("queue") for q in config.get("queues", {}).get("producers", [])}
            | {q.get("queue") for q in config.get("queues", {}).get("consumers", [])}
        ),
        "r2": sorted(b.get("bucket_name") for b in config.get("r2_buckets", [])),
        "d1": sorted(d.get("database_name") for d in config.get("d1_databases", [])),
    }
    return names


def binding_shape(config):
    return {
        "d1": sorted(d.get("binding") for d in config.get("d1_databases", [])),
        "durable_objects": sorted(
            (b.get("name"), b.get("class_name"))
            for b in config.get("durable_objects", {}).get("bindings", [])
        ),
        "exports": config.get("exports"),
        "r2": sorted(b.get("binding") for b in config.get("r2_buckets", [])),
        "workflows": sorted(
            (w.get("binding"), w.get("class_name")) for w in config.get("workflows", [])
        ),
        "queue_producers": sorted(q.get("binding") for q in config.get("queues", {}).get("producers", [])),
        "main": config.get("main"),
        "compatibility_date": config.get("compatibility_date"),
    }


def check_staging_config(base, staging, target, entry_source):
    exported = set(re.findall(r"export\s+\{\s*(\w+)\s*\}", entry_source))
    exported |= set(re.findall(r"export\s+class\s+(\w+)", entry_source))

    class_reasons = []
    exports = staging.get("exports") or {}
    if "migrations" in staging:
        class_reasons.append("LEGACY_MIGRATIONS_WITH_EXPORTS")
    for binding in staging.get("durable_objects", {}).get("bindings", []):
        cls = binding.get("class_name")
        declared = exports.get(cls) or {}
        if declared.get("type") != "durable-object" or declared.get("storage") != "sqlite":
            class_reasons.append(f"DO_CLASS_NOT_SQLITE_EXPORT:{cls}")
        if cls not in exported:
            class_reasons.append(f"DO_CLASS_NOT_EXPORTED_BY_WORKER:{cls}")
        if binding.get("script_name"):
            class_reasons.append(f"DO_BINDING_CROSS_SCRIPT:{cls}")
    for workflow in staging.get("workflows", []):
        if workflow.get("class_name") not in exported:
            class_reasons.append(f"WORKFLOW_CLASS_NOT_EXPORTED:{workflow.get('class_name')}")

    binding_reasons = []
    if binding_shape(base) != binding_shape(staging):
        binding_reasons.append("STAGING_BINDINGS_DIFFER_FROM_BASE")
    producers = {q.get("queue") for q in staging.get("queues", {}).get("producers", [])}
    consumers = {q.get("queue"): q for q in staging.get("queues", {}).get("consumers", [])}
    for queue in producers:
        if queue not in consumers:
            binding_reasons.append(f"QUEUE_WITHOUT_CONSUMER:{queue}")
    for queue, consumer in consumers.items():
        dlq = consumer.get("dead_letter_queue")
        if dlq and dlq not in consumers:
            binding_reasons.append(f"DEAD_LETTER_QUEUE_UNCONSUMED:{dlq}")
        if dlq and consumer.get("retry_delay", 0) < 1:
            binding_reasons.append(f"QUEUE_RETRY_WITHOUT_DELAY:{queue}")

    isolation_reasons = []
    base_names, staging_names = resource_names(base), resource_names(staging)
    for kind, values in staging_names.items():
        values = values if isinstance(values, list) else [values]
        base_values = base_names[kind] if isinstance(base_names[kind], list) else [base_names[kind]]
        for value in values:
            if not value or "staging" not in value:
                isolation_reasons.append(f"STAGING_NAME_NOT_ISOLATED:{kind}:{value}")
            if value in base_values:
                isolation_reasons.append(f"STAGING_REUSES_BASE_RESOURCE:{kind}:{value}")
    if staging.get("account_id") != target.get("account_id"):
        isolation_reasons.append("STAGING_ACCOUNT_NOT_PINNED")
    if staging.get("workers_dev") is not False or staging.get("preview_urls") is not False:
        isolation_reasons.append("STAGING_PUBLIC_WORKERS_DEV_ENABLED")
    for database in staging.get("d1_databases", []):
        if database.get("database_id") == (base.get("d1_databases") or [{}])[0].get("database_id"):
            isolation_reasons.append("STAGING_REUSES_BASE_DATABASE_ID")

    gates = {
        "DO_CLASSES_VALIDATED_LOCALLY": gate(class_reasons),
        "DO_BINDINGS_VALIDATED_LOCALLY": gate(binding_reasons),
        "STAGING_CONFIG_ISOLATED": gate(isolation_reasons),
    }
    unprovisioned = []
    for database in staging.get("d1_databases", []):
        if is_placeholder(database.get("database_id")):
            unprovisioned.append(f"d1:{database.get('database_name')}")
    vars_ = staging.get("vars") or {}
    for key in ("ACCESS_TEAM_DOMAIN", "ACCESS_AUD"):
        if is_placeholder(vars_.get(key)):
            unprovisioned.append(f"var:{key}")
    passed = all(g["status"] == "PASS" for g in gates.values())
    return {
        "tool": "roomagent-staging-config-check",
        "format": 1,
        "gates": gates,
        "unprovisioned_placeholders": unprovisioned,
        "DO_REMOTE_PROVISIONING_NOT_PERFORMED": True,
        "result": "PASS" if passed else "FAIL",
        "deploy_ready": passed and not unprovisioned,
    }


# ---------------------------------------------------------------- CLI


def load_evidence(directory):
    directory = Path(directory)
    evidence = {}
    for key in ("account", "info", "ledger", "schema", "foreign_keys"):
        path = directory / f"{key}.json"
        if path.exists():
            evidence[key] = json.loads(path.read_text())
    return evidence


def emit(report, out):
    text = json.dumps(report, indent=2, sort_keys=True)
    if out:
        Path(out).write_text(text + "\n")
    print(text)
    return 0 if report.get("result") == "PASS" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    manifest = sub.add_parser("manifest", help="check or rewrite the migration checksum manifest")
    manifest.add_argument("--write", action="store_true")
    sub.add_parser("plan", help="local migration plan gate")
    verify = sub.add_parser("verify", help="all D1 gates from captured read-only evidence")
    verify.add_argument("--evidence-dir", required=True)
    verify.add_argument("--target", default=str(TARGET))
    verify.add_argument("--config", default=str(STAGING_CONFIG))
    verify.add_argument("--out")
    config = sub.add_parser("config", help="static staging Wrangler configuration gates")
    config.add_argument("--out")
    args = parser.parse_args(argv)

    if args.command == "manifest":
        current = build_manifest()
        if args.write:
            MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            MANIFEST.write_text(json.dumps(current, indent=2) + "\n")
            return 0
        stored = json.loads(MANIFEST.read_text())
        same = stored == current
        print(json.dumps({"manifest": str(MANIFEST.relative_to(ROOT)), "result": "PASS" if same else "FAIL"}))
        return 0 if same else 1
    if args.command == "plan":
        plan_gate, files = check_plan(MIGRATIONS_DIR, json.loads(MANIFEST.read_text()))
        return emit(
            {
                "gates": {"STAGING_MIGRATION_PLAN_VERIFIED": plan_gate},
                "migrations": [p.name for p in files],
                "result": plan_gate["status"],
            },
            None,
        )
    if args.command == "verify":
        report = verify_d1(
            json.loads(Path(args.target).read_text()),
            load_jsonc(args.config),
            json.loads(MANIFEST.read_text()),
            load_evidence(args.evidence_dir),
        )
        return emit(report, args.out)
    report = check_staging_config(
        load_jsonc(BASE_CONFIG),
        load_jsonc(STAGING_CONFIG),
        json.loads(TARGET.read_text()),
        WORKER_ENTRY.read_text(),
    )
    return emit(report, args.out)


if __name__ == "__main__":
    sys.exit(main())
