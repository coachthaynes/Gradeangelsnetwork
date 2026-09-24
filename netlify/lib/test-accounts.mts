import { db } from "./db.mts";

// Test accounts let the owner walk through the whole site before Checkr and
// Stripe are connected. List their emails, comma separated, in the
// TEST_ACCOUNT_EMAILS setting on Netlify. For those accounts only:
//   * a Grade Angel's background check and payout setup count as done
//   * a teacher's payment is recorded as paid without charging a card
//   * the Grade Angel's payout is recorded as sent without moving money
//   * a gift given from a test email is credited without a card
// Everything they create is marked test_mode. Remove an email from the
// setting to turn it off.
export function testAccountEmails(): string[] {
  return String(Netlify.env.get("TEST_ACCOUNT_EMAILS") || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isTestEmail(email: unknown): boolean {
  const e = String(email || "").trim().toLowerCase();
  return Boolean(e) && testAccountEmails().includes(e);
}

export async function isTestUser(userId: number): Promise<boolean> {
  if (!testAccountEmails().length) return false;
  const [u] = await db.sql`SELECT email FROM users WHERE id = ${userId}`;
  return isTestEmail(u?.email);
}
