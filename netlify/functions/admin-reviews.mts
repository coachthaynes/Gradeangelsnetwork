import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { logAction, requireStaff } from "../lib/staff.mts";

// GET  ?filter=low|hidden     every review, newest first
// POST { review_id, hidden }  hide or restore a review
export default async (req: Request) => {
  const staff = await requireStaff(req);
  if (staff instanceof Response) return staff;

  if (req.method === "POST") {
    const body = await readJson(req);
    const reviewId = Number(body?.review_id);
    const hidden = body?.hidden === true;
    if (!Number.isInteger(reviewId)) return json({ error: "review_id is required" }, 400);
    const rows = await db.sql`UPDATE reviews SET hidden = ${hidden} WHERE id = ${reviewId} RETURNING id, rating, comment`;
    if (!rows.length) return json({ error: "Review not found" }, 404);
    await logAction(staff.session.id, hidden ? "hid review" : "restored review", "review", reviewId,
      `${rows[0].rating} stars: ${(rows[0].comment || "").slice(0, 120)}`);
    return json({ ok: true }, 200);
  }
  if (req.method !== "GET") return methodNotAllowed(["GET", "POST"]);

  const filter = new URL(req.url).searchParams.get("filter") || "";
  const reviews = await db.sql`
    SELECT r.id, r.assignment_id, r.rating, r.comment, r.hidden, r.created_at,
           au.id AS author_id, au.full_name AS author, au.role AS author_role,
           su.id AS subject_id, su.full_name AS subject, su.role AS subject_role
    FROM reviews r
    JOIN users au ON au.id = r.author_id
    JOIN users su ON su.id = r.subject_id
    WHERE (${filter} = '' OR (${filter} = 'low' AND r.rating <= 2) OR (${filter} = 'hidden' AND r.hidden))
    ORDER BY r.created_at DESC
    LIMIT 300
  `;
  return json({ reviews }, 200);
};

export const config: Config = {
  path: "/api/admin/reviews",
};
