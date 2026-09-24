import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { getSetupStatus } from "../lib/grade-angel.mts";
import { photoUrl } from "../lib/profiles.mts";
import { logAction, requireStaff } from "../lib/staff.mts";

const CHECK_STATUSES = new Set(["not_started", "invited", "pending", "clear", "consider"]);

// GET  ?q=&role=&filter=     search teachers and Grade Angels
// GET  ?id=                  one person in full: details, setup, work, reviews
// POST { user_id, action }   suspend, unsuspend, or set_background_check
export default async (req: Request) => {
  const staff = await requireStaff(req);
  if (staff instanceof Response) return staff;
  const url = new URL(req.url);

  if (req.method === "POST") {
    const body = await readJson(req);
    const userId = Number(body?.user_id);
    const action = String(body?.action || "");
    if (!Number.isInteger(userId)) return json({ error: "user_id is required" }, 400);
    const [target] = await db.sql`SELECT id, role, full_name FROM users WHERE id = ${userId}`;
    if (!target) return json({ error: "User not found" }, 404);
    if (target.role === "admin") return json({ error: "Manage staff from the Staff tab" }, 400);

    if (action === "suspend") {
      const reason = String(body?.reason || "").trim().slice(0, 300);
      if (reason.length < 3) return json({ error: "Give a reason for the suspension" }, 400);
      await db.sql`UPDATE users SET suspended_at = NOW(), suspended_reason = ${reason} WHERE id = ${userId}`;
      await logAction(staff.session.id, "suspended user", "user", userId, `${target.full_name}: ${reason}`);
    } else if (action === "unsuspend") {
      await db.sql`UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ${userId}`;
      await logAction(staff.session.id, "restored user", "user", userId, target.full_name);
    } else if (action === "set_background_check") {
      const status = String(body?.status || "");
      if (target.role !== "grade_angel") return json({ error: "Only Grade Angels have background checks" }, 400);
      if (!CHECK_STATUSES.has(status)) return json({ error: "Unknown background check status" }, 400);
      await db.sql`UPDATE users SET background_check_status = ${status} WHERE id = ${userId}`;
      await logAction(staff.session.id, "set background check", "user", userId, `${target.full_name}: ${status}`);
    } else {
      return json({ error: "Unknown action" }, 400);
    }
    return json({ ok: true }, 200);
  }

  if (req.method !== "GET") return methodNotAllowed(["GET", "POST"]);

  const id = Number(url.searchParams.get("id"));
  if (Number.isInteger(id) && id > 0) {
    const [u] = await db.sql`
      SELECT id, email, role, full_name, display_name, phone, city, state, zip, school_or_org, bio,
             subjects, grade_levels, assignment_types, qualifications, highest_degree, degree_field,
             teaching_certificate, certification_state, years_experience, background_check_status,
             stripe_account_id, stripe_payouts_ready, contractor_signature_name, contractor_agreement_signed_at,
             suspended_at, suspended_reason, photo_updated_at, created_at
      FROM users WHERE id = ${id} AND role <> 'admin'
    `;
    if (!u) return json({ error: "User not found" }, 404);
    const work = u.role === "teacher"
      ? await db.sql`SELECT id, title, status, page_count, rate_per_page_cents, created_at FROM assignments WHERE teacher_id = ${id} ORDER BY created_at DESC LIMIT 50`
      : await db.sql`SELECT id, title, status, page_count, rate_per_page_cents, created_at FROM assignments WHERE grade_angel_id = ${id} ORDER BY created_at DESC LIMIT 50`;
    const reviews = await db.sql`
      SELECT r.id, r.rating, r.comment, r.hidden, r.created_at, a.full_name AS author
      FROM reviews r JOIN users a ON a.id = r.author_id WHERE r.subject_id = ${id} ORDER BY r.created_at DESC LIMIT 50
    `;
    return json(
      {
        user: { ...u, photo_url: photoUrl(u.id, u.photo_updated_at) },
        setup: u.role === "grade_angel" ? await getSetupStatus(id) : null,
        assignments: work,
        reviews,
      },
      200
    );
  }

  const q = `%${(url.searchParams.get("q") || "").trim().toLowerCase()}%`;
  const role = url.searchParams.get("role") || "";
  const filter = url.searchParams.get("filter") || "";
  const users = await db.sql`
    SELECT u.id, u.email, u.role, u.full_name, u.city, u.state, u.background_check_status, u.stripe_payouts_ready,
           u.personal_completed_at, u.profile_completed_at, u.contractor_agreement_signed_at,
           u.suspended_at, u.photo_updated_at, u.created_at,
           (SELECT ROUND(AVG(rating)::numeric, 1)::float FROM reviews r WHERE r.subject_id = u.id AND NOT r.hidden) AS rating,
           (SELECT COUNT(*)::int FROM assignments a WHERE a.teacher_id = u.id OR a.grade_angel_id = u.id) AS assignment_count
    FROM users u
    WHERE u.role <> 'admin'
      AND (${role} = '' OR u.role = ${role})
      AND (LOWER(u.full_name) LIKE ${q} OR LOWER(u.email) LIKE ${q})
      AND (${filter} = ''
           OR (${filter} = 'suspended' AND u.suspended_at IS NOT NULL)
           OR (${filter} = 'check_review' AND u.background_check_status = 'consider')
           OR (${filter} = 'in_setup' AND u.role = 'grade_angel' AND u.contractor_agreement_signed_at IS NULL))
    ORDER BY u.created_at DESC
    LIMIT 200
  `;
  return json({ users: users.map((u: any) => ({ ...u, photo_url: photoUrl(u.id, u.photo_updated_at) })) }, 200);
};

export const config: Config = {
  path: "/api/admin/users",
};
