import type { Config } from "@netlify/functions";
import { clearCookieHeader } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  return json({ ok: true }, 200, { "set-cookie": clearCookieHeader() });
};

export const config: Config = {
  path: "/api/auth/logout",
};
