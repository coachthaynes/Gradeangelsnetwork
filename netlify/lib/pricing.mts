import { db } from "./db.mts";

// Teachers set their own price per page. Two guardrails help them: a
// lowest price staff choose (so a Grade Angel's pay never drops too low),
// and a hint showing what similar work was actually accepted at.

export const DEFAULT_MIN_RATE_CENTS = 10;

export async function getMinRateCents(): Promise<number> {
  const [row] = await db.sql`SELECT value FROM site_settings WHERE key = 'min_rate_per_page_cents'`;
  const n = Number(row?.value);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MIN_RATE_CENTS;
}

// Fewer accepted assignments than this and there is no hint, since one or
// two prices say little about what is typical.
export const HINT_MIN_SAMPLES = 3;

// The middle price per page of accepted work like this, trying the closest
// match first: same type, grade level, and subject; then type and grade
// level; then type alone.
export async function priceHint(assignmentType: string, gradeLevel: string, subject: string) {
  const grade = gradeLevel.trim().toLowerCase();
  const subj = subject.trim().toLowerCase();
  const tries: { basis: string; grade: string | null; subject: string | null }[] = [
    { basis: "type_grade_subject", grade, subject: subj },
    { basis: "type_grade", grade, subject: null },
    { basis: "type", grade: null, subject: null },
  ];
  for (const t of tries) {
    if ((t.grade !== null && !t.grade) || (t.subject !== null && !t.subject)) continue;
    const [row] = await db.sql`
      SELECT COUNT(*)::int AS count,
             ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rate_per_page_cents))::int AS rate_cents
      FROM assignments
      WHERE accepted_at IS NOT NULL AND status IN ('accepted', 'submitted', 'completed')
        AND assignment_type = ${assignmentType}
        AND (${t.grade}::text IS NULL OR LOWER(TRIM(grade_level)) = ${t.grade})
        AND (${t.subject}::text IS NULL OR LOWER(TRIM(subject)) = ${t.subject})
    `;
    if (row.count >= HINT_MIN_SAMPLES) return { rate_cents: row.rate_cents, count: row.count, basis: t.basis };
  }
  return null;
}
