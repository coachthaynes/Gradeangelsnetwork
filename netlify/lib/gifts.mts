import crypto from "node:crypto";
import { db } from "./db.mts";
import { emailConfigured, firstName, getSettings, renderEmail, sendEmail } from "./email.mts";
import { publicName } from "./profiles.mts";

// Gift Angels pay for grading so cost is not a barrier for teachers. A gift
// goes to one teacher's gift balance (through their gift link) or to the
// community fund, which staff grant out to teachers. Teachers spend their
// balance when they pay for an assignment. Every move is written to
// gift_ledger, and each one happens in a single SQL statement so money can
// never be counted twice or lost halfway.

export const MIN_GIFT_CENTS = 500;
export const MAX_GIFT_CENTS = 500000;

export function newGiftToken(): string {
  return crypto.randomBytes(12).toString("base64url");
}

export function formatDollars(cents: number): string {
  return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
}

// Marks a gift paid and credits it, once. Returns the gift when this call
// did the crediting, or null if it was already credited (Stripe resends
// webhooks) or does not exist.
export async function creditPaidGift(giftId: number, paymentIntentId: string | null) {
  const [gift] = await db.sql`
    WITH g AS (
      UPDATE gifts SET status = 'paid', paid_at = NOW(),
             stripe_payment_intent_id = COALESCE(${paymentIntentId}, stripe_payment_intent_id)
      WHERE id = ${giftId} AND status = 'pending'
      RETURNING id, teacher_id, amount_cents, donor_name, donor_email, message, anonymous
    ),
    to_teacher AS (
      UPDATE users u SET gift_balance_cents = u.gift_balance_cents + g.amount_cents
      FROM g WHERE u.id = g.teacher_id
      RETURNING u.id
    ),
    to_fund AS (
      UPDATE gift_fund f SET balance_cents = f.balance_cents + g.amount_cents
      FROM g WHERE f.id = 1 AND g.teacher_id IS NULL
      RETURNING f.id
    ),
    ledger AS (
      INSERT INTO gift_ledger (teacher_id, amount_cents, kind, gift_id)
      SELECT teacher_id, amount_cents, 'gift', id FROM g
      RETURNING id
    )
    SELECT * FROM g
  `;
  return gift || null;
}

// Spends as much of a teacher's gift balance as is needed toward a pending
// payment. Returns the payment's gift total afterwards.
export async function applyGiftToPayment(paymentId: number, teacherId: number, totalCents: number): Promise<number> {
  await db.sql`
    WITH p AS (
      SELECT id, gift_cents FROM payments WHERE id = ${paymentId} AND status = 'pending' FOR UPDATE
    ),
    cur AS (
      SELECT u.id, LEAST(u.gift_balance_cents, ${totalCents} - p.gift_cents) AS take
      FROM users u, p WHERE u.id = ${teacherId}
      FOR UPDATE OF u
    ),
    debit AS (
      UPDATE users u SET gift_balance_cents = u.gift_balance_cents - cur.take
      FROM cur WHERE u.id = cur.id AND cur.take > 0
      RETURNING cur.take
    ),
    pay AS (
      UPDATE payments SET gift_cents = payments.gift_cents + debit.take
      FROM debit WHERE payments.id = ${paymentId}
      RETURNING payments.id
    ),
    ledger AS (
      INSERT INTO gift_ledger (teacher_id, amount_cents, kind, payment_id)
      SELECT ${teacherId}::int, -take, 'applied', ${paymentId}::int FROM debit
      RETURNING id
    )
    SELECT 1
  `;
  const [row] = await db.sql`SELECT gift_cents FROM payments WHERE id = ${paymentId}`;
  return row?.gift_cents ?? 0;
}

// Moves money from the community fund to a teacher. Returns false when the
// fund does not have that much.
export async function grantFromFund(teacherId: number, amountCents: number, staffId: number, note: string | null): Promise<boolean> {
  const rows = await db.sql`
    WITH f AS (
      UPDATE gift_fund SET balance_cents = balance_cents - ${amountCents}
      WHERE id = 1 AND balance_cents >= ${amountCents}
      RETURNING id
    ),
    t AS (
      UPDATE users SET gift_balance_cents = gift_balance_cents + ${amountCents}
      FROM f WHERE users.id = ${teacherId}
      RETURNING users.id
    ),
    ledger AS (
      INSERT INTO gift_ledger (teacher_id, amount_cents, kind, staff_id, note)
      SELECT NULL::int, ${-amountCents}::int, 'grant', ${staffId}::int, ${note}::text FROM f
      UNION ALL
      SELECT ${teacherId}::int, ${amountCents}::int, 'grant', ${staffId}::int, ${note}::text FROM f
      RETURNING id
    )
    SELECT id FROM f
  `;
  return rows.length > 0;
}

// The name a teacher sees for a supporter.
export function donorLabel(g: { anonymous: boolean; donor_name: string }): string {
  return g.anonymous ? "A Gift Angel who chose to stay anonymous" : g.donor_name;
}

// A thank you to the supporter and a note to the teacher. Never throws:
// the gift is already counted whether or not these go out.
export async function sendGiftEmails(gift: any) {
  if (!emailConfigured()) return;
  try {
    const settings = await getSettings();
    const fromName = settings.email_from_name || "The Grade Angels Team";
    const [teacher] = gift.teacher_id
      ? await db.sql`SELECT id, email, role, full_name, display_name FROM users WHERE id = ${gift.teacher_id}`
      : [];
    const amount = formatDollars(gift.amount_cents);
    const goesTo = teacher ? publicName(teacher) : "teachers who need it most";

    const thanks = renderEmail({
      subject: "Thank you for being a Gift Angel",
      body:
        `Hi {{first_name}},\n\nThank you. Your gift of **${amount}** will pay for grading for ${goesTo}, ` +
        `so a teacher gets an evening back without paying for it themselves.\n\n` +
        `Grade Angels Network is a for profit company, so this gift is not tax deductible. ` +
        `Your card statement and Stripe receipt are your record of it.`,
      vars: { first_name: firstName(gift.donor_name) },
      mailingAddress: settings.email_mailing_address || "",
      fromName,
    });
    await sendEmail({ to: gift.donor_email, ...thanks, replyTo: settings.email_reply_to, fromName }).catch((err) =>
      console.error("gift thank you email failed", err)
    );

    if (teacher) {
      const who = gift.anonymous ? "Someone who chose to stay anonymous" : gift.donor_name;
      const note = renderEmail({
        subject: `A Gift Angel sent you ${amount} for grading`,
        body:
          `Hi {{first_name}},\n\n${who} just sent you **${amount}** for grading help. ` +
          `It is in your gift balance now and is used automatically the next time you pay for an assignment.` +
          (gift.message ? `\n\nTheir message:\n${gift.message}` : ""),
        ctaLabel: "See your gifts",
        ctaPath: "/dashboard-teacher.html#gifts",
        vars: { first_name: firstName(teacher.full_name) },
        mailingAddress: settings.email_mailing_address || "",
        fromName,
      });
      await sendEmail({ to: teacher.email, ...note, replyTo: settings.email_reply_to, fromName }).catch((err) =>
        console.error("gift notice email failed", err)
      );
    }
  } catch (err) {
    console.error("gift emails failed", err);
  }
}

// Puts gift money back in the teacher's balance when an assignment is
// cancelled: from a payment that was never finished, or from one gift money
// paid for in full (no card charge to refund) whose Grade Angel was not paid.
// Returns how much went back.
export async function returnGiftForAssignment(assignmentId: number): Promise<number> {
  const [row] = await db.sql`
    WITH p AS (
      SELECT p.id, p.gift_cents, a.teacher_id
      FROM payments p JOIN assignments a ON a.id = p.assignment_id
      WHERE p.assignment_id = ${assignmentId} AND p.gift_cents > 0
        AND (p.status = 'pending'
             OR (p.status = 'paid' AND p.gift_cents >= p.amount_cents AND p.payout_status NOT IN ('transferred', 'processing')))
      FOR UPDATE OF p
    ),
    z AS (
      UPDATE payments SET gift_cents = 0,
             status = CASE WHEN payments.status = 'paid' THEN 'refunded' ELSE payments.status END
      FROM p WHERE payments.id = p.id
      RETURNING p.id, p.gift_cents, p.teacher_id
    ),
    credit AS (
      UPDATE users u SET gift_balance_cents = u.gift_balance_cents + s.total
      FROM (SELECT teacher_id, SUM(gift_cents)::int AS total FROM z GROUP BY teacher_id) s
      WHERE u.id = s.teacher_id
      RETURNING u.id
    ),
    ledger AS (
      INSERT INTO gift_ledger (teacher_id, amount_cents, kind, payment_id, note)
      SELECT teacher_id, gift_cents, 'applied', id, 'Returned when the assignment was cancelled' FROM z
      RETURNING id
    )
    SELECT COALESCE(SUM(gift_cents), 0)::int AS returned FROM z
  `;
  return row?.returned ?? 0;
}

// A teacher's @username: 3 to 20 lowercase letters, numbers, or underscores.
export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export function cleanHandle(raw: unknown): string {
  return String(raw || "").trim().replace(/^@+/, "").toLowerCase();
}

// Gives a teacher an @username if they do not have one yet, built from
// their public name (like "mshaynes" or "leep"), with a number added if
// it is taken. Returns the handle.
export async function ensureHandle(userId: number): Promise<string> {
  const [u] = await db.sql`SELECT id, role, full_name, display_name, handle FROM users WHERE id = ${userId}`;
  if (u.handle) return u.handle;
  let base = publicName(u).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  if (base.length < 3) base = (base + "teacher").slice(0, 16);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`;
    const rows = await db.sql`
      UPDATE users SET handle = ${candidate}
      WHERE id = ${userId} AND handle IS NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE LOWER(handle) = ${candidate})
      RETURNING handle
    `;
    if (rows.length) return rows[0].handle;
    const [again] = await db.sql`SELECT handle FROM users WHERE id = ${userId}`;
    if (again.handle) return again.handle;
  }
  const fallback = `${base.slice(0, 12)}${Math.floor(Math.random() * 90000) + 10000}`;
  await db.sql`UPDATE users SET handle = ${fallback} WHERE id = ${userId} AND handle IS NULL`;
  return fallback;
}

// Finds a teacher who can receive gifts, by gift link token or @username.
// Only teachers who have turned their gift link on can be found.
export async function findGiftTeacher(opts: { token?: unknown; handle?: unknown }) {
  const token = opts.token ? String(opts.token) : null;
  const handle = opts.handle ? cleanHandle(opts.handle) : null;
  if (!token && !handle) return null;
  const [t] = await db.sql`
    SELECT id, email, role, full_name, display_name, handle, gift_note, school_or_org, gift_show_school
    FROM users
    WHERE role = 'teacher' AND suspended_at IS NULL AND gift_link_token IS NOT NULL
      AND (${token}::text IS NOT NULL AND gift_link_token = ${token}
           OR ${handle}::text IS NOT NULL AND LOWER(handle) = ${handle})
  `;
  return t || null;
}

// What supporters may see about a teacher: public name, @username, their
// note, and their school only if they chose to show it.
export function publicGiftTeacher(t: any) {
  return {
    name: publicName(t),
    handle: t.handle,
    note: t.gift_note ?? null,
    school: t.gift_show_school && t.school_or_org ? t.school_or_org : null,
  };
}
