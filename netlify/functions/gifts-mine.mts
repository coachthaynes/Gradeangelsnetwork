import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { isSuspended } from "../lib/staff.mts";
import { cleanHandle, donorLabel, ensureHandle, HANDLE_RE, newGiftToken } from "../lib/gifts.mts";

// A teacher's gifts: their balance, their gift link, their @username, and
// who has given. POST turns the gift link on or off, or saves the note,
// @username, or whether their school shows to supporters.
export default async (req: Request) => {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "Gifts are for teachers" }, 403);

  if (req.method === "POST") {
    if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
    const body = await readJson(req);
    if (!body) return json({ error: "Body must be JSON" }, 400);
    if (body.action === "enable_link") {
      await db.sql`UPDATE users SET gift_link_token = COALESCE(gift_link_token, ${newGiftToken()}) WHERE id = ${session.id}`;
      await ensureHandle(session.id);
    } else if (body.action === "save_handle") {
      const handle = cleanHandle(body.handle);
      if (!HANDLE_RE.test(handle)) {
        return json({ error: "Use 3 to 20 letters, numbers, or underscores for your @username" }, 400);
      }
      const [taken] = await db.sql`SELECT 1 FROM users WHERE LOWER(handle) = ${handle} AND id <> ${session.id}`;
      if (taken) return json({ error: `@${handle} is taken. Try another.` }, 409);
      await db.sql`UPDATE users SET handle = ${handle} WHERE id = ${session.id}`;
    } else if (body.action === "save_school") {
      const school = String(body.school || "").trim().slice(0, 120) || null;
      await db.sql`UPDATE users SET school_or_org = ${school}, gift_show_school = ${body.show === true} WHERE id = ${session.id}`;
    } else if (body.action === "new_link") {
      // Replaces the link, so the old one stops working.
      await db.sql`UPDATE users SET gift_link_token = ${newGiftToken()} WHERE id = ${session.id}`;
    } else if (body.action === "disable_link") {
      await db.sql`UPDATE users SET gift_link_token = NULL WHERE id = ${session.id}`;
    } else if (body.action === "save_note") {
      const note = String(body.note || "").trim().slice(0, 300) || null;
      await db.sql`UPDATE users SET gift_note = ${note} WHERE id = ${session.id}`;
    } else {
      return json({ error: "Unknown action" }, 400);
    }
  } else if (req.method !== "GET") {
    return methodNotAllowed(["GET", "POST"]);
  }

  let [me] = await db.sql`SELECT gift_balance_cents, gift_link_token, gift_note, handle, school_or_org, gift_show_school FROM users WHERE id = ${session.id}`;
  // Teachers who turned their link on before @usernames existed get one now.
  if (me.gift_link_token && !me.handle) me = { ...me, handle: await ensureHandle(session.id) };
  const received = await db.sql`
    SELECT l.amount_cents, l.kind, l.created_at, g.donor_name, g.anonymous, g.message
    FROM gift_ledger l LEFT JOIN gifts g ON g.id = l.gift_id
    WHERE l.teacher_id = ${session.id} AND l.kind IN ('gift', 'grant')
    ORDER BY l.created_at DESC LIMIT 50
  `;
  const [totals] = await db.sql`
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE kind IN ('gift', 'grant')), 0)::int AS received_cents,
           COALESCE(-SUM(amount_cents) FILTER (WHERE kind = 'applied'), 0)::int AS spent_cents
    FROM gift_ledger WHERE teacher_id = ${session.id}
  `;

  return json({
    balance_cents: me.gift_balance_cents,
    link_path: me.gift_link_token ? `/give.html?t=${me.gift_link_token}` : null,
    note: me.gift_note,
    handle: me.handle,
    handle_path: me.gift_link_token && me.handle ? `/give.html?to=${me.handle}` : null,
    school: me.school_or_org,
    show_school: me.gift_show_school,
    ...totals,
    received: received.map((r: any) => ({
      amount_cents: r.amount_cents,
      created_at: r.created_at,
      from: r.kind === "grant" ? "The Grade Angels community fund" : donorLabel(r),
      message: r.kind === "gift" ? r.message : null,
    })),
  }, 200);
};

export const config: Config = {
  path: "/api/gifts/mine",
};
