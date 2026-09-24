import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { assignmentFilesStore } from "../lib/blobs.mts";

// Serves someone's profile photo to signed in members. The URL carries a
// version number that changes with each new photo, so browsers can cache
// it for a long time.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const userId = Number(new URL(req.url).searchParams.get("user_id"));
  if (!Number.isInteger(userId)) return json({ error: "user_id is required" }, 400);

  const [user] = await db.sql`SELECT photo_blob_key FROM users WHERE id = ${userId}`;
  if (!user?.photo_blob_key) return json({ error: "No photo" }, 404);

  const result = await assignmentFilesStore().getWithMetadata(user.photo_blob_key, { type: "arrayBuffer" });
  if (!result) return json({ error: "No photo" }, 404);

  return new Response(result.data as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": (result.metadata?.contentType as string) || "image/jpeg",
      "cache-control": "private, max-age=86400",
    },
  });
};

export const config: Config = {
  path: "/api/users/photo",
};
