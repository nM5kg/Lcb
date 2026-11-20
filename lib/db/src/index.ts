import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseUrl = process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: databaseUrl,
  // ROOT CAUSE (verified by tail logs, 30-request sample): a pg client
  // that sits idle in the pool and is then REUSED hangs forever on its next
  // query — the Neon pooler (or an intermediate NAT) silently drops the
  // idle TCP session, so the query is written into a dead socket and its
  // answer never comes back, and pg has no query timeout by default. Fresh
  // connections always work; the fix is purgeIdleClients(), run at the
  // start of every API request (see below). idleTimeoutMillis=1ms and
  // query_timeout=8s are safety nets only: in workerd the isolate freezes
  // between requests, so the idle-reaping timer cannot be relied on, and a
  // bounded 8s error (JSON 500, which the frontend retries) beats a hang.
  max: 20,
  idleTimeoutMillis: 1,
  connectionTimeoutMillis: process.env.VERCEL === "1" ? 5_000 : 10_000,
  query_timeout: 8_000,
  ...(process.env.VERCEL === "1" ? { allowExitOnIdle: true } : {}),
});
// An idle-client error (e.g. the Neon pooler closing a stale connection) is
// emitted as a Pool "error" event. Without a listener Node throws and the
// whole process/Worker isolate dies, killing every in-flight request
// mid-response — which the browser sees as a "Connection error" even though
// the credentials were never checked. Log it and keep serving instead.
pool.on("error", (err) => {
  console.error("Neon pool idle-client error", err);
});

/**
 * Drop every idle pg client from the pool. MUST run at the start of each
 * API request, before any query.
 *
 * Verified root cause (tail logs, 30-request sample): a query on a FRESH
 * client always succeeds (19/19), while a query on a REUSED idle client
 * always hangs (11/11) — the Neon pooler (or an intermediate NAT) silently
 * drops the idle TCP session, so the query is written into a dead socket
 * and its answer never comes back. pg's idleTimeoutMillis cannot prevent
 * this in workerd: the isolate freezes between requests, so the reaping
 * timer never fires while idle, and the next request acquires the stale
 * client before the timer can run. Purging idle clients synchronously at
 * request start is the deterministic fix: every request opens a fresh
 * connection in its own context. Reuse WITHIN one request stays allowed
 * (the socket was just created/used in this request's context).
 *
 * Uses pg-pool 3.13.0 internals (_idle / _remove), pinned in pnpm-lock.yaml.
 * Defensive: no-ops if the pool shape ever changes.
 */
export function purgeIdleClients(): void {
  try {
    const p = pool as unknown as {
      _idle?: Array<{ client: unknown }>;
      _remove?: (client: unknown) => void;
    };
    if (!p._idle?.length || typeof p._remove !== "function") return;
    for (const item of [...p._idle]) p._remove(item.client);
  } catch {
    // Never break a request because the purge could not run; query_timeout
    // and the Worker-level guard timer still bound any residual hang.
  }
}
export const db = drizzle(pool, { schema });

export * from "./schema";
