import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { getTishlQueue } from "../lib/tishl-queue";

const router = Router();

const step = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

function parseUserId(req: Request): number | null {
  const raw = String(req.query.user_id ?? "");
  if (!/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function noStore(res: Response): void {
  res.set("Cache-Control", "no-store");
}

/** Read-only: the member's current Tishl queue, newest first. */
router.get("/admin/tishl/queue", requireAdmin, step(async (req, res) => {
  const userId = parseUserId(req);
  if (userId === null) {
    res.status(400).json({ error: "user_id is required" });
    return;
  }
  const client = await pool.connect();
  try {
    const items = await getTishlQueue(client, userId);
    noStore(res);
    res.json({ user_id: userId, items });
  } finally {
    client.release();
  }
}));

/** Read-only: items the member already marked done. */
router.get("/admin/tishl/done", requireAdmin, step(async (req, res) => {
  const userId = parseUserId(req);
  if (userId === null) {
    res.status(400).json({ error: "user_id is required" });
    return;
  }
  const r = await pool.query(
    "SELECT user_id,item_kind,item_id,done_at,done_via FROM public.tishl_done " +
      "WHERE user_id=$1 ORDER BY done_at DESC,item_kind,item_id",
    [userId],
  );
  noStore(res);
  res.json({ user_id: userId, items: r.rows });
}));

/** Read-only: the member's Tishl reminders (pending, surfaced, cancelled). */
router.get("/admin/tishl/reminders", requireAdmin, step(async (req, res) => {
  const userId = parseUserId(req);
  if (userId === null) {
    res.status(400).json({ error: "user_id is required" });
    return;
  }
  const r = await pool.query(
    "SELECT id,user_id,item_kind,item_id,remind_at,status,created_at " +
      "FROM public.tishl_reminders WHERE user_id=$1 ORDER BY remind_at DESC,id DESC",
    [userId],
  );
  noStore(res);
  res.json({ user_id: userId, items: r.rows });
}));

export default router;
