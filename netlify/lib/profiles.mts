import { db } from "./db.mts";

// Reviews become public once both people on the assignment have reviewed
// each other, or after this many days, whichever comes first. Until then a
// review is private, so neither side can react to what the other wrote.
export const REVIEW_REVEAL_DAYS = 14;

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function photoBlobKey(userId: number): string {
  return `avatars/${userId}`;
}

// The name other people see. Grade Angels are shown by name; teachers by
// their chosen display name, or first name and last initial if they have
// not picked one, so a Grade Angel never sees a teacher's full name.
export function publicName(user: { role?: string; full_name?: string; display_name?: string | null } | Record<string, any>): string {
  if (user.role !== "teacher") return user.full_name;
  if (user.display_name) return user.display_name;
  const parts = user.full_name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

// Cache busting photo URL; null when there is no photo.
export function photoUrl(userId: number, updatedAt: string | Date | null): string | null {
  if (!updatedAt) return null;
  return `/api/users/photo?user_id=${userId}&v=${new Date(updatedAt).getTime()}`;
}

// Average star rating and count of a person's public reviews.
export async function ratingSummary(userId: number): Promise<{ average: number | null; count: number }> {
  const [row] = await db.sql`
    SELECT ROUND(AVG(r.rating)::numeric, 1)::float AS average, COUNT(*)::int AS count
    FROM reviews r
    WHERE r.subject_id = ${userId} AND NOT r.hidden
      AND (r.created_at < NOW() - make_interval(days => ${REVIEW_REVEAL_DAYS})
           OR EXISTS (SELECT 1 FROM reviews o WHERE o.assignment_id = r.assignment_id AND o.author_id = r.subject_id))
  `;
  return { average: row?.count ? row.average : null, count: row?.count ?? 0 };
}

// A person's most recent public reviews, with the author's public name.
export async function publicReviews(userId: number, limit = 20) {
  const rows = await db.sql`
    SELECT r.rating, r.comment, r.created_at, a.subject AS assignment_subject,
           u.id AS author_id, u.role AS author_role, u.full_name AS author_full_name,
           u.display_name AS author_display_name, u.photo_updated_at AS author_photo_updated_at
    FROM reviews r
    JOIN users u ON u.id = r.author_id
    JOIN assignments a ON a.id = r.assignment_id
    WHERE r.subject_id = ${userId} AND NOT r.hidden
      AND (r.created_at < NOW() - make_interval(days => ${REVIEW_REVEAL_DAYS})
           OR EXISTS (SELECT 1 FROM reviews o WHERE o.assignment_id = r.assignment_id AND o.author_id = r.subject_id))
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r: any) => ({
    rating: r.rating,
    comment: r.comment,
    created_at: r.created_at,
    assignment_subject: r.assignment_subject,
    author: {
      id: r.author_id,
      role: r.author_role,
      name: publicName({ role: r.author_role, full_name: r.author_full_name, display_name: r.author_display_name }),
      photo_url: photoUrl(r.author_id, r.author_photo_updated_at),
    },
  }));
}
