import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { photoUrl, publicName, publicReviews, ratingSummary } from "../lib/profiles.mts";
import { isActiveStaff } from "../lib/staff.mts";

// Someone's public About me: photo, bio, star rating, reviews, and a few
// facts about their work here. Teachers look at Grade Angels and Grade
// Angels look at teachers; a teacher's page never shows their real name,
// school, or contact details.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const userId = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(userId)) return json({ error: "id is required" }, 400);

  const [user] = await db.sql`
    SELECT id, role, full_name, display_name, handle, bio, photo_updated_at, created_at,
           subjects, grade_levels, assignment_types, qualifications, years_experience,
           highest_degree, teaching_certificate, city, state
    FROM users WHERE id = ${userId}
  `;
  if (!user || user.role === "admin") return json({ error: "Profile not found" }, 404);

  const isSelf = user.id === session.id;
  const staff = session.role === "admin" && (await isActiveStaff(session.id));
  const allowed = isSelf || staff || (session.role !== "admin" && session.role !== user.role);
  if (!allowed) return json({ error: "Profile not found" }, 404);

  const profile: Record<string, unknown> = {
    id: user.id,
    role: user.role,
    name: publicName(user),
    bio: user.bio,
    photo_url: photoUrl(user.id, user.photo_updated_at),
    member_since: user.created_at,
    rating: await ratingSummary(user.id),
    reviews: await publicReviews(user.id, 20),
  };

  if (user.role === "grade_angel") {
    const [stats] = await db.sql`
      SELECT COUNT(*)::int AS completed, COALESCE(SUM(page_count), 0)::int AS pages
      FROM assignments WHERE grade_angel_id = ${user.id} AND status = 'completed'
    `;
    Object.assign(profile, {
      subjects: user.subjects,
      grade_levels: user.grade_levels,
      assignment_types: user.assignment_types,
      qualifications: user.qualifications,
      years_experience: user.years_experience,
      highest_degree: user.highest_degree,
      teaching_certificate: user.teaching_certificate,
      location: user.city && user.state ? `${user.city}, ${user.state}` : null,
      assignments_completed: stats.completed,
      pages_graded: stats.pages,
    });
  } else {
    const [stats] = await db.sql`
      SELECT COUNT(*) FILTER (WHERE status <> 'draft' AND status <> 'cancelled')::int AS posted,
             COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
      FROM assignments WHERE teacher_id = ${user.id}
    `;
    Object.assign(profile, { handle: user.handle, assignments_posted: stats.posted, assignments_completed: stats.completed });
  }

  return json({ profile, is_self: isSelf }, 200);
};

export const config: Config = {
  path: "/api/users/profile",
};
