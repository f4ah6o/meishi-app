import { GbizinfoRegistry } from "@meishi/server/src/corporate/gbizinfo.ts";
import { NtaRegistry } from "@meishi/server/src/corporate/nta.ts";
import { type CorporateRegistry, NullRegistry } from "@meishi/server/src/corporate/registry.ts";
import {
  type DecisionProvider,
  JevDecisionProvider,
  RuleDecisionProvider,
} from "@meishi/server/src/decision/decision.ts";
import type { DataStore } from "@meishi/server/src/kintone/store.ts";
import { companyNameKey, normalizeCard } from "@meishi/server/src/normalize/normalize.ts";
import { identify } from "@meishi/server/src/pipeline/identify.ts";
import { rankContacts } from "@meishi/server/src/pipeline/ranking.ts";
import { accessLog, rateLimit } from "@meishi/server/src/security/accessLog.ts";
import type {
  AnalyzeResponse,
  ConfirmedCardData,
  ConfirmResponse,
  MeetingContext,
  SuggestResponse,
} from "@meishi/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { loadWorkerConfig, type WorkerConfig, type WorkerEnv } from "./env.ts";
import type { ImageCardExtractor } from "./extract/opencodeVision.ts";
import { OpenCodeVisionExtractor } from "./extract/opencodeVision.ts";
import { accessIdentity } from "./security/accessIdentity.ts";
import { D1Store } from "./store/d1Store.ts";

export interface WorkerDeps {
  config: WorkerConfig;
  /** Null when OPENCODE_API_KEY is unset — analyze returns 503, never faked. */
  extractor: ImageCardExtractor | null;
  store: DataStore;
  registry: CorporateRegistry;
  decider: DecisionProvider;
}

type Bindings = { Bindings: WorkerEnv };

export function buildDeps(env: WorkerEnv): WorkerDeps {
  const config = loadWorkerConfig(env);
  const extractor = config.opencodeApiKey
    ? new OpenCodeVisionExtractor({
        baseUrl: config.opencodeBaseUrl,
        apiKey: config.opencodeApiKey,
        model: config.opencodeModel,
        timeoutMs: config.opencodeTimeoutMs,
        session: config.opencodeSession,
      })
    : null;
  const store = new D1Store(env.DB);
  const registry =
    config.corporateRegistry === "gbizinfo"
      ? new GbizinfoRegistry(config.gbizinfoApiToken)
      : config.corporateRegistry === "nta" && config.ntaAppId
        ? new NtaRegistry(config.ntaAppId)
        : new NullRegistry();
  const rule = new RuleDecisionProvider();
  const decider =
    config.decisionProvider === "jev"
      ? new JevDecisionProvider(config.jevEndpoint, config.jevApiKey, rule)
      : rule;
  return { config, extractor, store, registry, decider };
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];

function sniffImage(buf: Uint8Array): { mediaType: string } | null {
  const starts = (magic: number[]) => magic.every((b, i) => buf[i] === b);
  if (starts(JPEG_MAGIC)) return { mediaType: "image/jpeg" };
  if (starts(PNG_MAGIC)) return { mediaType: "image/png" };
  if (
    starts(WEBP_RIFF) &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { mediaType: "image/webp" };
  }
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function createWorkerApp(deps: WorkerDeps): Hono<Bindings> {
  const app = new Hono<Bindings>();
  const { config, extractor, store, registry, decider } = deps;
  const ruleDecider =
    decider instanceof RuleDecisionProvider ? decider : new RuleDecisionProvider();
  const identifyDeps = { store, registry, decider, ruleDecider };

  app.use("*", accessLog);
  app.use("*", accessIdentity(config));
  app.use("/api/*", rateLimit(config.rateLimitPerMinute));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: Math.ceil(config.maxImageBytes * 1.5), // base64 inflates ~4/3
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post("/api/cards/analyze", async (c) => {
    const body = await c.req.json<{ image_base64?: string }>().catch(() => null);
    if (!body?.image_base64) {
      return c.json({ error: "bad_request", message: "image_base64 required" }, 400);
    }
    if (!extractor) {
      return c.json(
        {
          error: "extractor_not_configured",
          message:
            "Card extraction is not configured: set the OPENCODE_API_KEY secret " +
            "(wrangler secret put OPENCODE_API_KEY) for the OpenCode Zen Go API.",
        },
        503,
      );
    }
    let buf: Uint8Array;
    try {
      buf = base64ToBytes(body.image_base64);
    } catch {
      return c.json({ error: "bad_request", message: "invalid base64" }, 400);
    }
    if (buf.length === 0 || buf.length > config.maxImageBytes) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const image = sniffImage(buf);
    if (!image) {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    try {
      const raw = await extractor.extract({ bytes: buf, mediaType: image.mediaType });
      const card = normalizeCard(raw);
      const result: AnalyzeResponse = await identify(card, raw, identifyDeps);
      console.log(
        JSON.stringify({
          type: "ai_extraction",
          identity: c.get("identity")?.email,
          company_key: card.company_name_key,
          uncertain: card.uncertain_fields,
          decision: result.decision,
        }),
      );
      return c.json(result);
    } catch (e) {
      console.error(JSON.stringify({ type: "extract_error", message: String(e) }));
      return c.json({ error: "extraction_failed", message: String(e) }, 502);
    }
  });

  app.get("/api/contacts/suggest", async (c) => {
    const qParam = c.req.query("q") ?? "";
    if (!qParam) return c.json<SuggestResponse>({ contacts: [] });
    const contacts = await store.searchContacts({ personName: qParam });
    const companyMatches = await store.searchContacts({ companyNameKey: qParam });
    const seen = new Set<string>();
    const merged = [...contacts, ...companyMatches].filter((ct) => {
      if (seen.has(ct.person_id)) return false;
      seen.add(ct.person_id);
      return true;
    });
    return c.json<SuggestResponse>({ contacts: merged.slice(0, 10) });
  });

  app.get("/api/contacts/recent", async (c) => {
    const companyKey = c.req.query("company") || undefined;
    const personName = c.req.query("person") || undefined;
    const recent = await store.listRecentContacts(20);
    const ranked = rankContacts(recent, {
      companyNameKey: companyKey,
      personName,
    });
    return c.json<SuggestResponse>({ contacts: ranked.slice(0, 10) });
  });

  app.get("/api/contacts/:personId/context", async (c) => {
    const personId = c.req.param("personId");
    const contact = await store.getContact(personId);
    if (!contact) return c.json({ error: "not_found" }, 404);
    const interactions = await store.listInteractions({
      personId,
      corporationId: contact.corporation_id,
    });
    const ctx: MeetingContext = { contact, recent_interactions: interactions };
    return c.json(ctx);
  });

  app.post("/api/cards/confirm", async (c) => {
    const data = await c.req.json<ConfirmedCardData>().catch(() => null);
    if (!data?.company_name || !data.person_name) {
      return c.json(
        { error: "bad_request", message: "company_name and person_name required" },
        400,
      );
    }

    // Resolve an explicitly chosen contact before any writes — a bad
    // person_id must reject without leaving store side effects.
    const chosenContact = data.person_id ? await store.getContact(data.person_id) : null;
    if (data.person_id && !chosenContact) {
      return c.json({ error: "bad_request", message: "person_id not found" }, 400);
    }

    // A client-supplied corporate_number is evidence, not proof: it must be
    // well-formed and resolvable via an existing corporation record or the
    // public registry before the record may be marked verified.
    const corporateNumber = data.corporate_number?.trim() || undefined;
    if (corporateNumber && !/^\d{13}$/.test(corporateNumber)) {
      return c.json({ error: "bad_request", message: "corporate_number must be 13 digits" }, 400);
    }
    let corporationVerified = false;
    let verifiedOfficialName: string | undefined;
    if (corporateNumber) {
      const existing = await store.findCorporationByNumber(corporateNumber);
      // A stored record is authoritative only when it was itself verified —
      // otherwise resubmitting the same arbitrary number twice would
      // self-promote to verified. Unverified numbers are re-checked against
      // the public registry, and a hit upgrades the stored record below.
      let authoritative = existing?.verification_status === "verified" ? existing : null;
      if (!authoritative && registry.findByNumber) {
        authoritative = await registry.findByNumber(corporateNumber).catch(() => null);
      }
      if (authoritative) {
        // The number must actually belong to the submitted company: a forged
        // or mistyped pairing of this number with a different name is refused
        // rather than persisted as verified.
        const submittedKey = companyNameKey(data.official_name || data.company_name);
        if (submittedKey !== companyNameKey(authoritative.official_name)) {
          return c.json(
            {
              error: "conflict",
              message: "corporate_number does not match the submitted company name",
            },
            409,
          );
        }
        corporationVerified = true;
        verifiedOfficialName = authoritative.official_name;
      }
    }

    const corpData = {
      officialName: verifiedOfficialName ?? data.official_name ?? data.company_name,
      corporateNumber,
      verificationStatus: corporationVerified ? "verified" : "unverified",
    };
    // An explicitly chosen person must actually belong to the corporation
    // this confirm resolves to — never link a card across corporations.
    if (chosenContact?.corporation_id) {
      const resolved = await store.resolveCorporation(corpData);
      if (resolved !== chosenContact.corporation_id) {
        return c.json(
          { error: "conflict", message: "person_id belongs to a different corporation" },
          409,
        );
      }
    }

    // Duplicate prevention: corporation identity = corporate_number first.
    const corp = await store.getOrCreateCorporation({
      ...corpData,
      address: data.address,
      website: data.website,
    });
    // An explicitly chosen person_id is the user's decision; without one,
    // getOrCreateContact merges only on a real identifier match.
    let contact: { personId: string; deduplicated: boolean };
    if (chosenContact) {
      contact = { personId: chosenContact.person_id, deduplicated: true };
    } else {
      contact = await store.getOrCreateContact({
        corporationId: corp.corporationId,
        name: data.person_name,
        department: data.department,
        title: data.title,
        email: data.email,
        phone: data.phone,
        mobile: data.mobile,
      });
    }
    const card = await store.createBusinessCard({
      personId: contact.personId,
      corporationId: corp.corporationId,
      // Ephemeral retention keeps no image to reference.
      imageReference: "",
      rawExtraction: data.raw_extraction ?? "",
      confirmedData: JSON.stringify(data),
      decisionConfidence:
        typeof data.decision_confidence === "number"
          ? Math.min(1, Math.max(0, data.decision_confidence))
          : 0,
      reviewStatus: "confirmed",
    });
    let interactionId: string | undefined;
    if (data.meeting) {
      const created = await store.createInteraction({
        corporationId: corp.corporationId,
        personId: contact.personId,
        interactionType: data.meeting.interaction_type,
        interactionAt: data.meeting.interaction_at,
        summary: data.meeting.summary,
        nextAction: data.meeting.next_action,
      });
      interactionId = created.interactionId;
    }
    console.log(
      JSON.stringify({
        type: "card_registered",
        identity: c.get("identity")?.email,
        corporation_id: corp.corporationId,
        person_id: contact.personId,
        business_card_id: card.businessCardId,
        deduplicated: corp.deduplicated,
      }),
    );
    const res: ConfirmResponse = {
      corporation_id: corp.corporationId,
      person_id: contact.personId,
      business_card_id: card.businessCardId,
      interaction_id: interactionId,
      deduplicated: corp.deduplicated,
      corporation_verified: corporationVerified,
    };
    return c.json(res);
  });

  // Non-API requests: hand to the static-assets binding (PWA). Reached only
  // after the identity middleware, so assets stay behind Access as well.
  app.all("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
    const assets = c.env.ASSETS;
    if (!assets) return c.json({ error: "not_found" }, 404);
    return assets.fetch(c.req.raw);
  });

  return app;
}
