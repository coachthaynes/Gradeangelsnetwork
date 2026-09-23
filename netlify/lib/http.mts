export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
  });
}

export function methodNotAllowed(allowed: string[]): Response {
  return json({ error: "Method not allowed" }, 405, { allow: allowed.join(", ") });
}
