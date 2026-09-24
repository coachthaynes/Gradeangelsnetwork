import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { deleteAssignmentFiles, readJson, recordEvent } from "../lib/assignments.mts";
import { logAction, requireStaff } from "../lib/staff.mts";
import { returnGiftForAssignment } from "../lib/gifts.mts";

// GET  ?q=&status=&overdue=1      search every assignment
// POST { assignment_id, reason }  cancel one (manager). Paid assignments
//                                 need a refund in Stripe first, so they
//                                 cannot be cancelled from here.
export default async (req: Request) => {
  if (req.method === "POST") {
    const staff = await requireStaff(req, "manager");
    if (staff instanceof Response) return staff;
    const body = await readJson(req);
    const assignmentId = Number(body?.assignment_id);
    const reason = String(body?.reason || "").trim().slice(0, 300);
    if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
    if (reason.length < 3) return json({ error: "Give a reason for cancelling" }, 400);

    const [paid] = await db.sql`
      SELECT 1 FROM payments
      WHERE assignment_id = ${assignmentId} AND status = 'paid'
        -- Paid entirely with gift money and not yet paid out: nothing to
        -- refund in Stripe, the gift goes back to the teacher instead.
        AND NOT (gift_cents >= amount_cents + service_fee_cents AND payout_status NOT IN ('transferred', 'processing'))
      LIMIT 1
    `;
    if (paid) return json({ error: "This assignment was paid for. Refund it in Stripe before cancelling." }, 409);

    const rows = await db.sql`
      UPDATE assignments SET status = 'cancelled', cancelled_at = NOW(), invited_grade_angel_id = NULL
      WHERE id = ${assignmentId} AND status NOT IN ('completed', 'cancelled')
      RETURNING id, title
    `;
    if (!rows.length) return json({ error: "Completed or already cancelled assignments cannot be cancelled" }, 409);

    await deleteAssignmentFiles(assignmentId);
    await recordEvent(assignmentId, staff.session.id, "cancelled", `By Grade Angels staff: ${reason}`);
    await logAction(staff.session.id, "cancelled assignment", "assignment", assignmentId, `${rows[0].title}: ${reason}`);
    const giftReturnedCents = await returnGiftForAssignment(assignmentId);
    return json({ ok: true, gift_returned_cents: giftReturnedCents }, 200);
  }

  if (req.method !== "GET") return methodNotAllowed(["GET", "POST"]);
  const staff = await requireStaff(req);
  if (staff instanceof Response) return staff;

  const url = new URL(req.url);
  const q = `%${(url.searchParams.get("q") || "").trim().toLowerCase()}%`;
  const status = url.searchParams.get("status") || "";
  const overdue = url.searchParams.get("overdue") === "1";

  const assignments = await db.sql`
    SELECT a.id, a.title, a.subject, a.grade_level, a.status, a.page_count, a.rate_per_page_cents,
           COALESCE(a.total_cents, a.page_count * a.rate_per_page_cents) AS total_cents,
           a.created_at, a.accepted_at, a.due_at, a.completed_at,
           t.id AS teacher_id, t.full_name AS teacher_name, g.id AS grade_angel_id, g.full_name AS grade_angel_name,
           p.status AS payment_status, p.payout_status,
           (SELECT COUNT(*)::int FROM assignment_messages m WHERE m.assignment_id = a.id) AS message_count
    FROM assignments a
    JOIN users t ON t.id = a.teacher_id
    LEFT JOIN users g ON g.id = a.grade_angel_id
    LEFT JOIN LATERAL (
      SELECT status, payout_status FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
    ) p ON true
    WHERE (${status} = '' OR a.status = ${status})
      AND (NOT ${overdue} OR (a.status = 'accepted' AND a.due_at < NOW()))
      AND (LOWER(a.title) LIKE ${q} OR LOWER(a.subject) LIKE ${q} OR LOWER(t.full_name) LIKE ${q}
           OR LOWER(COALESCE(g.full_name, '')) LIKE ${q})
    ORDER BY a.created_at DESC
    LIMIT 200
  `;
  return json({ assignments }, 200);
};

export const config: Config = {
  path: "/api/admin/assignments",
};
