import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { REVIEW_REVEAL_DAYS, photoUrl } from "../lib/profiles.mts";
import { isActiveStaff } from "../lib/staff.mts";

// Grade Angels a teacher can invite: only ones whose setup is fully done,
// so an invite never lands on someone who cannot accept it. The same
// conditions as getSetupStatus's "ready", written as a query.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher" && !(session.role === "admin" && (await isActiveStaff(session.id)))) {
    return json({ error: "Only teachers can browse Grade Angels" }, 403);
  }

  const gradeAngels = await db.sql`
    SELECT u.id, u.full_name, u.subjects, u.grade_levels, u.assignment_types, u.qualifications, u.bio,
           u.photo_updated_at, rv.average AS rating_average, rv.count AS rating_count,
           (SELECT COUNT(*)::int FROM assignments a WHERE a.grade_angel_id = u.id AND a.status = 'completed')
             AS completed_count,
           (SELECT COALESCE(SUM(a.page_count), 0)::int FROM assignments a
             WHERE a.grade_angel_id = u.id AND a.status = 'completed') AS pages_graded
    FROM users u
    LEFT JOIN LATERAL (
      SELECT ROUND(AVG(r.rating)::numeric, 1)::float AS average, COUNT(*)::int AS count
      FROM reviews r
      WHERE r.subject_id = u.id AND NOT r.hidden
        AND (r.created_at < NOW() - make_interval(days => ${REVIEW_REVEAL_DAYS})
             OR EXISTS (SELECT 1 FROM reviews o WHERE o.assignment_id = r.assignment_id AND o.author_id = r.subject_id))
    ) rv ON true
    WHERE u.role = 'grade_angel'
      AND u.personal_completed_at IS NOT NULL
      AND u.profile_completed_at IS NOT NULL
      AND u.confidentiality_agreed_at IS NOT NULL
      AND u.contractor_agreement_signed_at IS NOT NULL
      AND u.background_check_status = 'clear'
      AND u.stripe_payouts_ready
    ORDER BY rv.average DESC NULLS LAST, completed_count DESC, u.full_name
  `;

  return json(
    {
      grade_angels: gradeAngels.map(({ photo_updated_at, rating_average, rating_count, ...g }: any) => ({
        ...g,
        photo_url: photoUrl(g.id, photo_updated_at),
        rating: { average: rating_count ? rating_average : null, count: rating_count },
      })),
    },
    200
  );
};

export const config: Config = {
  path: "/api/grade-angels",
};
