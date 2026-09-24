// In memory stand in for @netlify/blobs.
const stores = new Map();
export function getStore({ name }) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    async set(key, data, opts = {}) { m.set(key, { data: data instanceof ArrayBuffer ? data : new TextEncoder().encode(String(data)).buffer, metadata: opts.metadata || {} }); },
    async get(key) { return m.get(key)?.data ?? null; },
    async getWithMetadata(key) { const v = m.get(key); return v ? { data: v.data, metadata: v.metadata } : null; },
    async delete(key) { m.delete(key); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
export const __stores = stores;
