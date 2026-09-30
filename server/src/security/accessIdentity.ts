import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppConfig } from "../config.ts";

/**
 * Verifies the Cloudflare Access JWT forwarded in `Cf-Access-Jwt-Assertion`.
 * The gateway must only be reachable through Cloudflare Tunnel + Access in
 * production; locally, AUTH_MODE=dev trusts a fixed dev identity instead.
 */
export function accessIdentity(config: AppConfig) {
  const certsUrl =
    config.accessTeamName && config.accessTeamName.length > 0
      ? new URL(`https://${config.accessTeamName}.cloudflareaccess.com/cdn-cgi/access/certs`)
      : null;
  const jwks = certsUrl ? createRemoteJWKSet(certsUrl) : null;

  return createMiddleware(async (c, next) => {
    if (config.authMode === "dev") {
      c.set("identity", { email: config.devUserEmail });
      await next();
      return;
    }

    if (!jwks || !config.accessAud) {
      return c.json(
        { error: "auth_misconfigured", message: "ACCESS_TEAM_NAME and ACCESS_AUD are required" },
        500,
      );
    }

    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        audience: config.accessAud,
      });
      const email = (payload as { email?: string }).email;
      if (!email) {
        return c.json({ error: "unauthenticated" }, 401);
      }
      c.set("identity", { email });
      await next();
    } catch {
      return c.json({ error: "unauthenticated" }, 401);
    }
  });
}
