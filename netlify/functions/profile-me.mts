import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { photoUrl, publicName, publicReviews, ratingSummary } from "../lib/profiles.mts";

// GET: your own About me, as others see it, plus the reviews people have
// left you. POST: update your bio (and, for teachers, the display name
// Grade Angels see instead of your real name).
export default async (req: Request) => {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  if (req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json({ error: "Body must be JSON" }, 400);
    const bio = String(body.bio ?? "").trim().slice(0, 1000);

    if (session.role === "grade_angel" && bio.length < 20) {
      return json({ error: "Tell teachers a little about yourself (at least 20 characters)" }, 400);
    }

    if (session.role === "teacher") {
      const displayName = String(body.display_name ?? "").trim().slice(0, 40);
      await db.sql`
        UPDATE users SET bio = ${bio || null}, display_name = ${displayName || null} WHERE id = ${session.id}
      `;
    } else {
      await db.sql`UPDATE users SET bio = ${bio} WHERE id = ${session.id}`;
    }
  } else if (req.method !== "GET") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const [user] = await db.sql`
    SELECT id, role, full_name, display_name, bio, photo_updated_at, created_at FROM users WHERE id = ${session.id}
  `;
  if (!user) return json({ error: "Account not found" }, 404);

  return json(
    {
      profile: {
        id: user.id,
        role: user.role,
        full_name: user.full_name,
        display_name: user.display_name,
        public_name: publicName(user),
        bio: user.bio,
        photo_url: photoUrl(user.id, user.photo_updated_at),
        member_since: user.created_at,
        rating: await ratingSummary(user.id),
        reviews: await publicReviews(user.id, 10),
      },
    },
    200
  );
};

export const config: Config = {
  path: "/api/profile",
};
