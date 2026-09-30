import { createMiddleware } from "hono/factory";

export type Identity = { email: string };

declare module "hono" {
  interface ContextVariableMap {
    identity: Identity;
  }
}

/** Structured one-line access log per request. */
export const accessLog = createMiddleware(async (c, next) => {
  const start = Date.now();
  await next();
  const identity = c.get("identity")?.email ?? "-";
  console.log(
    JSON.stringify({
      type: "access",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - start,
      identity,
      ua: c.req.header("user-agent") ?? "-",
    }),
  );
});

/** Simple fixed-window rate limiter keyed on the caller identity. */
export function rateLimit(perMinute: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return createMiddleware(async (c, next) => {
    const key = c.get("identity")?.email ?? c.req.header("cf-connecting-ip") ?? "anonymous";
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > perMinute) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });
}
