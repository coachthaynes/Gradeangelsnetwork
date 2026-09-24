import { db } from "./db.mts";
import { emailConfigured, firstName, getSettings, renderEmail, sendEmail } from "./email.mts";

// A short email about someone's own assignment (graded work is ready,
// changes were asked for, and so on). These are not marketing, so they have
// no unsubscribe link. Never throws: the action already happened whether or
// not the email goes out.
export async function notifyUser(userId: number | null, msg: { subject: string; body: string; ctaLabel?: string; ctaPath?: string }) {
  if (!userId || !emailConfigured()) return;
  try {
    const [u] = await db.sql`SELECT email, full_name FROM users WHERE id = ${userId}`;
    if (!u) return;
    const settings = await getSettings();
    const fromName = settings.email_from_name || "The Grade Angels Team";
    const email = renderEmail({
      subject: msg.subject,
      body: `Hi {{first_name}},\n\n${msg.body}`,
      ctaLabel: msg.ctaLabel,
      ctaPath: msg.ctaPath,
      vars: { first_name: firstName(u.full_name) },
      mailingAddress: settings.email_mailing_address || "",
      fromName,
    });
    await sendEmail({ to: u.email, ...email, replyTo: settings.email_reply_to, fromName });
  } catch (err) {
    console.error("notify failed", msg.subject, err);
  }
}
