import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { WorkerConfig } from "../env.ts";

/** ctx.access — present only on Access-authenticated Worker invocations. */
interface AccessBinding {
  getIdentity(): Promise<{ email?: string } | null | undefined>;
}

/**
 * Cloudflare Access enforcement for every route (PWA assets and /api/* —
 * assets run_worker_first through this Worker).
 *
 * Identity sources, in order:
 *   1. `ctx.access.getIdentity()` — set by Cloudflare only when the Access
 *      application bound to this Worker authenticated the request.
 *   2. `Cf-Access-Jwt-Assertion` verified against the team's Access JWKS with
 *      issuer + audience checks (defense in depth; also covers setups where
 *      ctx.access is not populated).
 *
 * Fails closed: no configured/valid identity → 401. AUTH_MODE=dev is honored
 * only when ENVIRONMENT=local (wrangler dev via .dev.vars) — production vars
 * never set it.
 */
export function accessIdentity(config: WorkerConfig) {
  const certsUrl = config.accessTeamName
    ? new URL(`https://${config.accessTeamName}.cloudflareaccess.com/cdn-cgi/access/certs`)
    : null;
  const jwks = certsUrl ? createRemoteJWKSet(certsUrl) : null;

  return createMiddleware(async (c, next) => {
    if (config.environment === "local" && config.authMode === "dev") {
      c.set("identity", { email: config.devUserEmail });
      await next();
      return;
    }

    const access = (c.executionCtx as unknown as { access?: AccessBinding }).access;
    let email: string | undefined;
    if (access) {
      const identity = await access.getIdentity().catch(() => null);
      email = identity?.email ?? undefined;
    }

    if (!email) {
      const token = c.req.header("cf-access-jwt-assertion");
      if (token && jwks && config.accessAud) {
        try {
          const { payload } = await jwtVerify(token, jwks, {
            issuer: `https://${config.accessTeamName}.cloudflareaccess.com`,
            audience: config.accessAud,
          });
          email = (payload as { email?: string }).email;
        } catch {
          email = undefined;
        }
      }
    }

    if (!email) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    c.set("identity", { email });
    await next();
  });
}
