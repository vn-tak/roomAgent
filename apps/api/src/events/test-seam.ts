import { FAULT_AGENT, FAULT_CRASH, FAULT_D1 } from "./names";

const FAULTS = "event_test_faults";
const COUNTERS = "event_test_counters";

export function isTestHarness(env: object): boolean {
  return "TEST_MIGRATIONS" in env;
}

export async function armEventFault(
  db: D1Database,
  kind: typeof FAULT_CRASH | typeof FAULT_D1 | typeof FAULT_AGENT,
  remaining: number,
): Promise<void> {
  await ensureFaults(db);
  await db
    .prepare(
      `INSERT INTO ${FAULTS} (kind, remaining) VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET remaining = excluded.remaining`,
    )
    .bind(kind, remaining)
    .run();
}

export async function clearEventFaults(db: D1Database): Promise<void> {
  await ensureFaults(db);
  await db.prepare(`DELETE FROM ${FAULTS}`).run();
}

export async function takeEventFault(
  env: object & { DB: D1Database },
  kind: string,
): Promise<boolean> {
  if (!isTestHarness(env)) {
    return false;
  }
  try {
    const row = await env.DB.prepare(
      `UPDATE ${FAULTS} SET remaining = remaining - 1
       WHERE kind = ? AND remaining > 0
       RETURNING remaining`,
    )
      .bind(kind)
      .first<{ remaining: number }>();
    return row !== null;
  } catch {
    return false;
  }
}

export async function bumpEventCounter(
  env: object & { DB: D1Database },
  name: string,
): Promise<void> {
  if (!isTestHarness(env)) {
    return;
  }
  await ensureCounters(env.DB);
  await env.DB.prepare(
    `INSERT INTO ${COUNTERS} (name, n) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET n = n + 1`,
  )
    .bind(name)
    .run();
}

export async function readEventCounter(db: D1Database, name: string): Promise<number> {
  await ensureCounters(db);
  const row = await db
    .prepare(`SELECT n FROM ${COUNTERS} WHERE name = ?`)
    .bind(name)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function ensureFaults(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${FAULTS} (kind TEXT PRIMARY KEY, remaining INTEGER NOT NULL)`,
    )
    .run();
}

async function ensureCounters(db: D1Database): Promise<void> {
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS ${COUNTERS} (name TEXT PRIMARY KEY, n INTEGER NOT NULL)`)
    .run();
}
