import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { assignmentFilesStore } from "../lib/blobs.mts";
import { PHOTO_CONTENT_TYPES, PHOTO_MAX_BYTES, photoBlobKey, photoUrl } from "../lib/profiles.mts";

// POST uploads your profile photo (the browser crops it to a square and
// shrinks it first). DELETE removes it.
export default async (req: Request) => {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  const store = assignmentFilesStore();
  const key = photoBlobKey(session.id);

  if (req.method === "DELETE") {
    await store.delete(key);
    await db.sql`UPDATE users SET photo_blob_key = NULL, photo_updated_at = NULL WHERE id = ${session.id}`;
    return json({ photo_url: null }, 200);
  }
  if (req.method !== "POST") return methodNotAllowed(["POST", "DELETE"]);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart form data" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return json({ error: "Choose a photo" }, 400);
  if (file.size > PHOTO_MAX_BYTES) return json({ error: "That photo is too large" }, 413);
  if (!PHOTO_CONTENT_TYPES.has(file.type)) return json({ error: "Photos must be JPEG, PNG, or WebP" }, 415);

  await store.set(key, await file.arrayBuffer(), { metadata: { contentType: file.type } });
  const [user] = await db.sql`
    UPDATE users SET photo_blob_key = ${key}, photo_updated_at = NOW() WHERE id = ${session.id}
    RETURNING photo_updated_at
  `;
  return json({ photo_url: photoUrl(session.id, user.photo_updated_at) }, 200);
};

export const config: Config = {
  path: "/api/profile/photo",
};
