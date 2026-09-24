import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { can, logAction, requireStaff } from "../lib/staff.mts";
import { formatDollars, grantFromFund } from "../lib/gifts.mts";

// Gift Angels for staff: what has been given, the community fund, and
// which teachers hold gift money. Managers and above can grant money from
// the community fund to a teacher.
export default async (req: Request) => {
  const staff = await requireStaff(req);
  if (staff instanceof Response) return staff;

  if (req.method === "POST") {
    if (!can(staff.level, "manager")) return json({ error: "This needs manager access. Ask the master admin." }, 403);
    const body = await readJson(req);
    if (!body || body.action !== "grant") return json({ error: "Unknown action" }, 400);
    const amountCents = Math.round(Number(body.amount_cents));
    if (!Number.isInteger(amountCents) || amountCents <= 0) return json({ error: "Enter an amount" }, 400);
    const email = String(body.teacher_email || "").trim().toLowerCase();
    const [teacher] = await db.sql`SELECT id, full_name FROM users WHERE LOWER(email) = ${email} AND role = 'teacher'`;
    if (!teacher) return json({ error: "No teacher has that email address" }, 404);
    const note = String(body.note || "").trim().slice(0, 300) || null;
    const ok = await grantFromFund(teacher.id, amountCents, staff.session.id, note);
    if (!ok) return json({ error: "The community fund does not have that much right now" }, 409);
    await logAction(staff.session.id, "gift_grant", "user", teacher.id, `${formatDollars(amountCents)} from the community fund${note ? `: ${note}` : ""}`);
    return json({ ok: true, message: `Granted ${formatDollars(amountCents)} to ${teacher.full_name}.` }, 200);
  }
  if (req.method !== "GET") return methodNotAllowed(["GET", "POST"]);

  const [fund] = await db.sql`SELECT balance_cents FROM gift_fund WHERE id = 1`;
  const [totals] = await db.sql`
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)::int AS raised_cents,
           COUNT(*) FILTER (WHERE status = 'paid')::int AS gifts,
           COUNT(DISTINCT LOWER(donor_email)) FILTER (WHERE status = 'paid')::int AS donors,
           COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid' AND paid_at > NOW() - INTERVAL '30 days'), 0)::int AS raised_30d_cents
    FROM gifts WHERE NOT test_mode
  `;
  const [spent] = await db.sql`
    SELECT COALESCE(-SUM(amount_cents), 0)::int AS spent_cents FROM gift_ledger WHERE kind = 'applied'
  `;
  const [held] = await db.sql`SELECT COALESCE(SUM(gift_balance_cents), 0)::int AS cents FROM users WHERE role = 'teacher'`;

  const gifts = await db.sql`
    SELECT g.id, g.amount_cents, g.donor_name, g.donor_email, g.message, g.anonymous, g.status, g.created_at, g.paid_at, g.test_mode,
           g.teacher_id, t.full_name AS teacher_name
    FROM gifts g LEFT JOIN users t ON t.id = g.teacher_id
    WHERE g.status <> 'pending' OR g.created_at > NOW() - INTERVAL '2 days'
    ORDER BY g.created_at DESC LIMIT 100
  `;
  const teachers = await db.sql`
    SELECT u.id, u.full_name, u.email, u.gift_balance_cents, (u.gift_link_token IS NOT NULL) AS link_on,
           COALESCE((SELECT SUM(amount_cents) FROM gift_ledger l WHERE l.teacher_id = u.id AND l.kind IN ('gift', 'grant')), 0)::int AS received_cents
    FROM users u
    WHERE u.role = 'teacher' AND (u.gift_balance_cents > 0 OR u.gift_link_token IS NOT NULL
      OR EXISTS (SELECT 1 FROM gift_ledger l WHERE l.teacher_id = u.id))
    ORDER BY received_cents DESC, u.full_name LIMIT 200
  `;

  return json({
    fund_cents: fund?.balance_cents ?? 0,
    totals: { ...totals, spent_cents: spent.spent_cents, held_by_teachers_cents: held.cents },
    gifts,
    teachers,
    can_grant: can(staff.level, "manager"),
  }, 200);
};

export const config: Config = {
  path: "/api/admin/gifts",
};
