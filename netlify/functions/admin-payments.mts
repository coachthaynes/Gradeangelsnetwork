import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { logAction, requireStaff } from "../lib/staff.mts";

// Every payment from a teacher and payout to a Grade Angel.
// ?payout=failed|held|transferred filters; ?format=csv downloads a
// spreadsheet for bookkeeping (manager and above).
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const url = new URL(req.url);
  const csv = url.searchParams.get("format") === "csv";
  const staff = await requireStaff(req, csv ? "manager" : "support");
  if (staff instanceof Response) return staff;

  const payout = url.searchParams.get("payout") || "";
  const rows = await db.sql`
    SELECT p.id, p.assignment_id, a.title, t.full_name AS teacher, g.full_name AS grade_angel,
           p.amount_cents, p.platform_fee_cents, (p.amount_cents - p.platform_fee_cents) AS payout_cents,
           p.status, p.payout_status, p.payout_attempts, p.payout_error, p.paid_at, p.transferred_at,
           p.stripe_payment_intent_id, p.stripe_transfer_id, a.status AS assignment_status
    FROM payments p
    JOIN assignments a ON a.id = p.assignment_id
    JOIN users t ON t.id = a.teacher_id
    LEFT JOIN users g ON g.id = a.grade_angel_id
    WHERE (${payout} = '' OR p.payout_status = ${payout})
    ORDER BY p.id DESC
    LIMIT 1000
  `;

  if (!csv) return json({ payments: rows }, 200);

  await logAction(staff.session.id, "exported payments", null, null, `${rows.length} rows`);
  const cols = ["id", "assignment_id", "title", "teacher", "grade_angel", "amount", "platform_fee", "grade_angel_payout",
    "payment_status", "payout_status", "paid_at", "transferred_at", "stripe_payment_intent_id", "stripe_transfer_id"];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dollars = (c: number) => (c / 100).toFixed(2);
  const lines = [cols.join(",")].concat(rows.map((r: any) => [
    r.id, r.assignment_id, r.title, r.teacher, r.grade_angel, dollars(r.amount_cents), dollars(r.platform_fee_cents),
    dollars(r.payout_cents), r.status, r.payout_status, r.paid_at, r.transferred_at, r.stripe_payment_intent_id, r.stripe_transfer_id,
  ].map(cell).join(",")));
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="grade-angels-payments-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};

export const config: Config = {
  path: "/api/admin/payments",
};
