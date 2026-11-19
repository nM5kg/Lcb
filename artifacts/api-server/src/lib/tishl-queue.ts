import type { PoolClient } from "pg";

/**
 * Tishl queue (Olam Chesed path 12, "מיין טישל", IVR path "1591").
 * The queue is tasks + cases + missed return calls + unread messages,
 * NEWEST FIRST, for one member. All queries are parameterized and scoped
 * by user_id / owner_user_id. Nothing here touches production data.
 */

export type TishlItemKind = "task" | "case" | "missed_call" | "message";

export const TISHL_ITEM_KINDS: readonly TishlItemKind[] = [
  "task",
  "case",
  "missed_call",
  "message",
];

export type TishlQueueItem = {
  kind: TishlItemKind;
  id: number;
  title: string;
  detail: string;
  phone: string | null;
  created_at: string;
  held: boolean;
};

/** max_return_calls statuses that still need a return call. 'completed' is done. */
export const TISHL_OPEN_RETURN_CALL_STATUSES: readonly string[] = [
  "menu",
  "connecting",
  "voicemail",
  "missed",
  "busy",
  "unavailable",
];

/** The status the return-call flow itself writes when the call is finished. */
export const TISHL_RETURN_CALL_DONE_STATUS = "completed";

function assertKind(kind: string): asserts kind is TishlItemKind {
  if (!(TISHL_ITEM_KINDS as readonly string[]).includes(kind)) {
    throw new Error("Invalid Tishl item kind: " + kind);
  }
}

function assertId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Invalid Tishl item id: " + String(id));
  }
}

/**
 * The member's Tishl queue, newest first.
 * - Open tasks (completed=false), open cases (status != 'closed'),
 *   open return calls, unread notifications.
 * - Items in tishl_done are excluded.
 * - Items with a pending reminder whose remind_at is still in the future
 *   are hidden until the reminder is due.
 * - Due reminders (remind_at <= now) surface the item and are marked
 *   status='surfaced' in the same call.
 * - Held items stay IN the queue with held=true; a hold never removes.
 */
export async function getTishlQueue(
  client: PoolClient,
  userId: number,
): Promise<TishlQueueItem[]> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Invalid user id");
  }
  // Surface due reminders first so their items re-enter the queue now.
  await client.query(
    "UPDATE public.tishl_reminders SET status='surfaced' " +
      "WHERE user_id=$1 AND status='pending' AND remind_at<=now()",
    [userId],
  );
  const r = await client.query<{
    kind: TishlItemKind;
    id: string;
    title: string;
    detail: string;
    phone: string | null;
    created_at: string;
    held: boolean;
  }>(
    "SELECT kind,id::bigint AS id,title,detail,phone,created_at::text AS created_at,held FROM (" +
      "SELECT 'task'::text AS kind,t.id,t.title," +
      "COALESCE(NULLIF(t.case_title,''),'') AS detail," +
      "NULL::text AS phone,t.created_at," +
      "EXISTS(SELECT 1 FROM public.tishl_holds h WHERE h.user_id=t.user_id " +
      "AND h.item_kind='task' AND h.item_id=t.id) AS held " +
      "FROM public.askanus_tasks t WHERE t.user_id=$1 AND t.completed=false " +
      "UNION ALL " +
      "SELECT 'case'::text,c.id,c.title,COALESCE(c.description,'') AS detail," +
      "NULL::text AS phone,c.created_at," +
      "EXISTS(SELECT 1 FROM public.tishl_holds h WHERE h.user_id=c.user_id " +
      "AND h.item_kind='case' AND h.item_id=c.id) AS held " +
      "FROM public.askanus_cases c WHERE c.user_id=$1 AND c.status!='closed' " +
      "UNION ALL " +
      "SELECT 'missed_call'::text,m.id," +
      "('Missed call from '||m.incoming_from) AS title," +
      "''::text AS detail,m.incoming_from AS phone,m.created_at," +
      "EXISTS(SELECT 1 FROM public.tishl_holds h WHERE h.user_id=m.owner_user_id " +
      "AND h.item_kind='missed_call' AND h.item_id=m.id) AS held " +
      "FROM public.max_return_calls m WHERE m.owner_user_id=$1 " +
      "AND m.status=ANY($2::text[]) " +
      "UNION ALL " +
      "SELECT 'message'::text,n.id,COALESCE(n.type,'message') AS title," +
      "COALESCE(n.message,'') AS detail,NULL::text AS phone,n.created_at," +
      "EXISTS(SELECT 1 FROM public.tishl_holds h WHERE h.user_id=n.user_id " +
      "AND h.item_kind='message' AND h.item_id=n.id) AS held " +
      "FROM public.notifications n WHERE n.user_id=$1 AND n.is_read=false" +
      ") q " +
      "WHERE NOT EXISTS(SELECT 1 FROM public.tishl_done d " +
      "WHERE d.user_id=$1 AND d.item_kind=q.kind AND d.item_id=q.id) " +
      "AND NOT EXISTS(SELECT 1 FROM public.tishl_reminders r " +
      "WHERE r.user_id=$1 AND r.item_kind=q.kind AND r.item_id=q.id " +
      "AND r.status='pending' AND r.remind_at>now()) " +
      "ORDER BY q.created_at DESC,kind,id DESC",
    [userId, [...TISHL_OPEN_RETURN_CALL_STATUSES]],
  );
  return r.rows.map((row) => ({
    kind: row.kind,
    id: Number(row.id),
    title: row.title,
    detail: row.detail,
    phone: row.phone,
    created_at: row.created_at,
    held: row.held,
  }));
}

/**
 * Mark an item done. Records the done-list entry and marks the source row:
 * task -> completed=true/completed_at=now(); message -> is_read=true;
 * missed call -> status='completed' (the status the return-call flow uses
 * for finished calls). A case is NOT closed: the done-list entry is the
 * record. Returns true when the item was newly marked done.
 */
export async function markTishlDone(
  client: PoolClient,
  userId: number,
  kind: TishlItemKind,
  id: number,
  doneVia = "tishl",
): Promise<boolean> {
  assertKind(kind);
  assertId(id);
  const done = await client.query(
    "INSERT INTO public.tishl_done(user_id,item_kind,item_id,done_via) " +
      "VALUES($1,$2,$3,$4) ON CONFLICT(user_id,item_kind,item_id) DO NOTHING RETURNING item_id",
    [userId, kind, id, String(doneVia).slice(0, 40)],
  );
  if (kind === "task") {
    await client.query(
      "UPDATE public.askanus_tasks SET completed=true,completed_at=now() " +
        "WHERE id=$1 AND user_id=$2 AND completed=false",
      [id, userId],
    );
  } else if (kind === "message") {
    await client.query(
      "UPDATE public.notifications SET is_read=true WHERE id=$1 AND user_id=$2 AND is_read=false",
      [id, userId],
    );
  } else if (kind === "missed_call") {
    await client.query(
      "UPDATE public.max_return_calls SET status=$3,updated_at=now() " +
        "WHERE id=$1 AND owner_user_id=$2",
      [id, userId, TISHL_RETURN_CALL_DONE_STATUS],
    );
  }
  // 'case': deliberately no source change; the tishl_done row is the record.
  return (done.rowCount ?? 0) > 0;
}

/** Delete the underlying row (and its Tishl side rows) for one queue item. */
export async function deleteTishlItem(
  client: PoolClient,
  userId: number,
  kind: TishlItemKind,
  id: number,
): Promise<boolean> {
  assertKind(kind);
  assertId(id);
  let removed = 0;
  if (kind === "task") {
    removed = (await client.query(
      "DELETE FROM public.askanus_tasks WHERE id=$1 AND user_id=$2",
      [id, userId],
    )).rowCount ?? 0;
  } else if (kind === "case") {
    removed = (await client.query(
      "DELETE FROM public.askanus_cases WHERE id=$1 AND user_id=$2",
      [id, userId],
    )).rowCount ?? 0;
  } else if (kind === "missed_call") {
    removed = (await client.query(
      "DELETE FROM public.max_return_calls WHERE id=$1 AND owner_user_id=$2",
      [id, userId],
    )).rowCount ?? 0;
  } else {
    removed = (await client.query(
      "DELETE FROM public.notifications WHERE id=$1 AND user_id=$2",
      [id, userId],
    )).rowCount ?? 0;
  }
  await client.query(
    "DELETE FROM public.tishl_done WHERE user_id=$1 AND item_kind=$2 AND item_id=$3",
    [userId, kind, id],
  );
  await client.query(
    "DELETE FROM public.tishl_reminders WHERE user_id=$1 AND item_kind=$2 AND item_id=$3",
    [userId, kind, id],
  );
  await client.query(
    "DELETE FROM public.tishl_notes WHERE user_id=$1 AND item_kind=$2 AND item_id=$3",
    [userId, kind, id],
  );
  await client.query(
    "DELETE FROM public.tishl_holds WHERE user_id=$1 AND item_kind=$2 AND item_id=$3",
    [userId, kind, id],
  );
  return removed > 0;
}

/** Set (replacing any pending) a reminder for one queue item. Returns its id. */
export async function setTishlReminder(
  client: PoolClient,
  userId: number,
  kind: TishlItemKind,
  id: number,
  remindAt: Date,
): Promise<number> {
  assertKind(kind);
  assertId(id);
  if (!(remindAt instanceof Date) || Number.isNaN(remindAt.getTime())) {
    throw new Error("Invalid remind_at");
  }
  await client.query(
    "UPDATE public.tishl_reminders SET status='cancelled' " +
      "WHERE user_id=$1 AND item_kind=$2 AND item_id=$3 AND status='pending'",
    [userId, kind, id],
  );
  const r = await client.query<{ id: string }>(
    "INSERT INTO public.tishl_reminders(user_id,item_kind,item_id,remind_at) " +
      "VALUES($1,$2,$3,$4) RETURNING id",
    [userId, kind, id, remindAt.toISOString()],
  );
  return Number(r.rows[0].id);
}

/** Add a note to one queue item. Returns the note id. */
export async function addTishlNote(
  client: PoolClient,
  userId: number,
  kind: TishlItemKind,
  id: number,
  note: string,
): Promise<number> {
  assertKind(kind);
  assertId(id);
  const text = String(note ?? "").trim();
  if (!text) throw new Error("Note is empty");
  const r = await client.query<{ id: string }>(
    "INSERT INTO public.tishl_notes(user_id,item_kind,item_id,note) " +
      "VALUES($1,$2,$3,$4) RETURNING id",
    [userId, kind, id, text.slice(0, 2000)],
  );
  return Number(r.rows[0].id);
}

/** Toggle the hold on one queue item. Returns the new held state. */
export async function toggleTishlHold(
  client: PoolClient,
  userId: number,
  kind: TishlItemKind,
  id: number,
): Promise<boolean> {
  assertKind(kind);
  assertId(id);
  const existing = await client.query(
    "SELECT 1 FROM public.tishl_holds WHERE user_id=$1 AND item_kind=$2 AND item_id=$3",
    [userId, kind, id],
  );
  if ((existing.rowCount ?? 0) > 0) {
    await client.query(
      "DELETE FROM public.tishl_holds WHERE user_id=$1 AND item_kind=$2 AND item_id=$3",
      [userId, kind, id],
    );
    return false;
  }
  await client.query(
    "INSERT INTO public.tishl_holds(user_id,item_kind,item_id) VALUES($1,$2,$3) " +
      "ON CONFLICT(user_id,item_kind,item_id) DO NOTHING",
    [userId, kind, id],
  );
  return true;
}
