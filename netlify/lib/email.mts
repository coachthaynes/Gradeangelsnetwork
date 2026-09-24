import { db } from "./db.mts";
import { signToken } from "./auth.mts";

// Sends email through Resend (https://resend.com). Needs two settings in
// Netlify: RESEND_API_KEY and EMAIL_FROM (an address on a domain verified in
// Resend, like hello@gradeangels.net). Until both are set, emails are
// recorded as skipped instead of sent, so nothing breaks.

export function emailConfigured(): boolean {
  return Boolean(Netlify.env.get("RESEND_API_KEY") && Netlify.env.get("EMAIL_FROM"));
}

export function siteUrl(): string {
  return (Netlify.env.get("SITE_URL") || Netlify.env.get("URL") || "https://grade-angels-network.netlify.app").replace(/\/$/, "");
}

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await db.sql`SELECT key, value FROM site_settings`;
  return Object.fromEntries(rows.map((r: any) => [r.key, r.value ?? ""]));
}

export type Recipient = { kind: "user" | "lead"; id: number; email: string; name: string | null };

export function unsubscribeUrl(r: Recipient): string {
  const id = `${r.kind}:${r.id}`;
  return `${siteUrl()}/api/email/unsubscribe?r=${encodeURIComponent(id)}&t=${signToken("unsubscribe:" + id)}`;
}

export function firstName(name: string | null | undefined): string {
  const first = String(name || "").trim().split(/\s+/)[0];
  return first || "there";
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Turns the simple body format used by the templates into HTML and plain
// text: blank lines separate paragraphs, "* " starts a bullet, "1. " a
// numbered step, **text** is bold, {{first_name}} is replaced.
export function renderBody(body: string, vars: Record<string, string>) {
  const filled = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
  const blocks = filled.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const inline = (t: string) => escape(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const html = blocks.map((block) => {
    const lines = block.split("\n").map((l) => l.trim());
    if (lines.every((l) => /^\* /.test(l))) {
      return `<ul style="margin:0 0 16px;padding-left:20px">${lines.map((l) => `<li style="margin:0 0 8px">${inline(l.slice(2))}</li>`).join("")}</ul>`;
    }
    if (lines.every((l) => /^\d+\. /.test(l))) {
      return `<ol style="margin:0 0 16px;padding-left:20px">${lines.map((l) => `<li style="margin:0 0 8px">${inline(l.replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`;
    }
    return `<p style="margin:0 0 16px">${lines.map(inline).join("<br>")}</p>`;
  }).join("");
  const text = filled.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^\* /gm, "• ");
  return { html, text, filled };
}

// The branded wrapper every marketing email uses: black header, white body,
// seafoam button, and a footer with the mailing address and unsubscribe
// link that marketing emails are required to have.
export function renderEmail(opts: {
  subject: string;
  body: string;
  ctaLabel?: string | null;
  ctaPath?: string | null;
  vars: Record<string, string>;
  unsubscribe: string;
  mailingAddress: string;
  fromName: string;
}) {
  const { html: bodyHtml, text: bodyText } = renderBody(opts.body, opts.vars);
  const ctaUrl = opts.ctaPath ? (opts.ctaPath.startsWith("http") ? opts.ctaPath : siteUrl() + opts.ctaPath) : null;
  const subject = opts.subject.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => opts.vars[k] ?? "");
  const html = `<!doctype html><html><body style="margin:0;background:#F2FBF8;font-family:Arial,Helvetica,sans-serif;color:#0B0B0B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2FBF8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;overflow:hidden">
<tr><td style="background:#0B0B0B;padding:18px 28px;border-bottom:3px solid #5FD3B3">
<span style="display:inline-block;width:32px;height:32px;line-height:32px;border-radius:50%;background:#5FD3B3;color:#0B0B0B;text-align:center;font-weight:bold;font-family:Georgia,serif">GA</span>
<span style="color:#FFFFFF;font-family:Georgia,serif;font-weight:bold;font-size:17px;margin-left:10px;vertical-align:middle">Grade Angels Network</span>
</td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.6">
${bodyHtml}
${ctaUrl && opts.ctaLabel ? `<p style="margin:24px 0 8px"><a href="${escape(ctaUrl)}" style="display:inline-block;background:#5FD3B3;color:#0B0B0B;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px">${escape(opts.ctaLabel)}</a></p>` : ""}
<p style="margin:24px 0 0">Warmly,<br>${escape(opts.fromName)}</p>
</td></tr>
<tr><td style="background:#0B0B0B;color:#9AA3A0;padding:18px 28px;font-size:12px;line-height:1.5">
Grade Angels Network${opts.mailingAddress ? `<br>${escape(opts.mailingAddress)}` : ""}<br>
<a href="${escape(opts.unsubscribe)}" style="color:#5FD3B3">Unsubscribe from these emails</a>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${bodyText}\n\n${ctaUrl && opts.ctaLabel ? `${opts.ctaLabel}: ${ctaUrl}\n\n` : ""}Warmly,\n${opts.fromName}\n\n\nGrade Angels Network${opts.mailingAddress ? `\n${opts.mailingAddress}` : ""}\nUnsubscribe: ${opts.unsubscribe}`;
  return { subject, html, text };
}

// Sends one email. Returns the provider's id, or throws with the reason.
export async function sendEmail(msg: { to: string; subject: string; html: string; text: string; replyTo?: string; fromName?: string; unsubscribe?: string }) {
  const key = Netlify.env.get("RESEND_API_KEY");
  const from = Netlify.env.get("EMAIL_FROM");
  if (!key || !from) throw new Error("Email is not connected yet (RESEND_API_KEY and EMAIL_FROM)");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: msg.fromName ? `${msg.fromName} <${from}>` : from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      reply_to: msg.replyTo || undefined,
      headers: msg.unsubscribe ? { "List-Unsubscribe": `<${msg.unsubscribe}>` } : undefined,
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Resend error ${res.status}`);
  return String(data.id || "");
}
