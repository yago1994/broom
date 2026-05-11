export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/analytics") {
      return new Response("Not Found", { status: 404, headers: cors() });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400, headers: cors() });
    }

    const { event, install_id, extension_version } = body;
    if (!event || !install_id) {
      return new Response("Bad Request", { status: 400, headers: cors() });
    }

    const now = Date.now();
    const date = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD

    await Promise.all([
      // Global event counter
      increment(env.ANALYTICS, `count:${event}`),
      // Global last-seen timestamp
      env.ANALYTICS.put(`last:${event}`, String(now)),
      // Per-user event counter
      increment(env.ANALYTICS, `count:${install_id}:${event}`),
      // Per-user last-seen timestamp
      env.ANALYTICS.put(`last_seen:${install_id}`, String(now)),
      // Daily presence key — 8-day TTL so stale entries auto-expire
      env.ANALYTICS.put(`daily:${date}:${install_id}`, "1", { expirationTtl: 8 * 24 * 60 * 60 }),
    ]);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", ...cors() },
    });
  },
};

async function increment(kv, key) {
  const current = await kv.get(key);
  const next = (parseInt(current ?? "0", 10) || 0) + 1;
  await kv.put(key, String(next));
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
