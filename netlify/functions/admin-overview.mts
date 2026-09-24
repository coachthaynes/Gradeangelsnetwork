import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { requireStaff } from "../lib/staff.mts";

// Headline numbers for the admin dashboard, plus the list of things that
// need a person to look at them.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const staff = await requireStaff(req);
  if (staff instanceof Response) return staff;

  const [users] = await db.sql`
    SELECT
      COUNT(*) FILTER (WHERE role = 'teacher')::int AS teachers,
      COUNT(*) FILTER (WHERE role = 'grade_angel')::int AS grade_angels,
      COUNT(*) FILTER (WHERE role = 'grade_angel' AND personal_completed_at IS NOT NULL
                         AND profile_completed_at IS NOT NULL AND confidentiality_agreed_at IS NOT NULL
                         AND contractor_agreement_signed_at IS NOT NULL AND background_check_status = 'clear'
                         AND stripe_payouts_ready)::int AS live_grade_angels,
      COUNT(*) FILTER (WHERE role <> 'admin' AND created_at > NOW() - INTERVAL '7 days')::int AS new_this_week,
      COUNT(*) FILTER (WHERE suspended_at IS NOT NULL)::int AS suspended
    FROM users
  `;

  const [assignments] = await db.sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'open')::int AS open,
      COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
      COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'accepted' AND due_at < NOW())::int AS overdue,
      COALESCE(SUM(page_count) FILTER (WHERE status = 'completed'), 0)::int AS pages_graded
    FROM assignments
  `;

  const [money] = await db.sql`
    SELECT
      COALESCE(SUM(amount_cents - gift_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS collected_cents,
      COALESCE(SUM(gift_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS gift_paid_cents,
      COALESCE(SUM(platform_fee_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS fees_cents,
      COALESCE(SUM(amount_cents - platform_fee_cents) FILTER (WHERE payout_status = 'transferred'), 0)::bigint AS paid_out_cents,
      COALESCE(SUM(amount_cents - platform_fee_cents) FILTER (WHERE status = 'paid' AND payout_status <> 'transferred'), 0)::bigint AS owed_cents,
      COALESCE(SUM(amount_cents - gift_cents) FILTER (WHERE status = 'paid' AND paid_at > NOW() - INTERVAL '30 days'), 0)::bigint AS collected_30d_cents
    FROM payments
  `;

  // Things that need a person, most urgent first.
  const attention: { kind: string; label: string; detail: string; link: string; created_at: string }[] = [];

  for (const a of await db.sql`
    SELECT a.id, a.title, a.due_at, g.full_name AS angel FROM assignments a
    LEFT JOIN users g ON g.id = a.grade_angel_id
    WHERE a.status = 'accepted' AND a.due_at < NOW() ORDER BY a.due_at LIMIT 20
  `) {
    attention.push({ kind: "overdue", label: `Overdue: ${a.title}`, detail: `${a.angel || "Grade Angel"} was due ${new Date(a.due_at).toLocaleString("en-US")}`, link: `/assignment.html?id=${a.id}`, created_at: a.due_at });
  }
  for (const p of await db.sql`
    SELECT p.assignment_id, p.payout_status, p.payout_error, p.payout_attempted_at, a.title FROM payments p
    JOIN assignments a ON a.id = p.assignment_id
    WHERE p.status = 'paid' AND p.payout_status IN ('failed', 'held') AND a.status = 'completed'
    ORDER BY p.payout_attempted_at NULLS LAST LIMIT 20
  `) {
    attention.push({ kind: "payout", label: `Payout ${p.payout_status}: ${p.title}`, detail: p.payout_error || "", link: "#payouts", created_at: p.payout_attempted_at });
  }
  for (const u of await db.sql`
    SELECT id, full_name, created_at FROM users WHERE role = 'grade_angel' AND background_check_status = 'consider' LIMIT 20
  `) {
    attention.push({ kind: "check", label: `Background check needs review: ${u.full_name}`, detail: "Checkr returned consider", link: `#user-${u.id}`, created_at: u.created_at });
  }
  for (const r of await db.sql`
    SELECT r.id, r.rating, r.comment, r.created_at, s.full_name AS subject FROM reviews r
    JOIN users s ON s.id = r.subject_id
    WHERE r.rating <= 2 AND NOT r.hidden AND r.created_at > NOW() - INTERVAL '14 days'
    ORDER BY r.created_at DESC LIMIT 20
  `) {
    attention.push({ kind: "review", label: `${r.rating} star review of ${r.subject}`, detail: r.comment || "", link: "#reviews", created_at: r.created_at });
  }
  for (const u of await db.sql`
    SELECT id, full_name, created_at FROM users
    WHERE role = 'grade_angel' AND contractor_agreement_signed_at IS NULL AND created_at < NOW() - INTERVAL '3 days'
    ORDER BY created_at DESC LIMIT 10
  `) {
    attention.push({ kind: "setup", label: `Stuck in setup: ${u.full_name}`, detail: "Signed up more than 3 days ago and has not finished steps 1 to 3", link: `#user-${u.id}`, created_at: u.created_at });
  }

  const signups = await db.sql`
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
           COUNT(*) FILTER (WHERE role = 'teacher')::int AS teachers,
           COUNT(*) FILTER (WHERE role = 'grade_angel')::int AS grade_angels
    FROM users WHERE created_at > NOW() - INTERVAL '14 days' AND role <> 'admin'
    GROUP BY 1 ORDER BY 1
  `;

  return json(
    {
      me: { name: staff.name, level: staff.level, is_master: staff.isMaster },
      users,
      assignments,
      money: Object.fromEntries(Object.entries(money).map(([k, v]) => [k, Number(v)])),
      attention,
      signups,
    },
    200
  );
};

export const config: Config = {
  path: "/api/admin/overview",
};
