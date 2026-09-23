import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { UserRole } from "./db.mts";

export const SESSION_COOKIE = "gan_session";

// Falls back to a fixed dev secret so `netlify dev` works before anyone has
// set a real one. Production MUST set SESSION_SECRET as an env var, which
// the deploy step for this project takes care of.
function getSecret(): string {
  return Netlify.env.get("SESSION_SECRET") || "dev-only-secret-change-me";
}

export interface SessionPayload {
  id: number;
  email: string;
  role: UserRole;
  full_name: string;
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: "30d" });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, getSecret()) as SessionPayload;
  } catch {
    return null;
  }
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") || "";
  const out: Record<string, string> = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

export function sessionCookieHeader(token: string): string {
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function getSession(req: Request): SessionPayload | null {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifySession(token);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
