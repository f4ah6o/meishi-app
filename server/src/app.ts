import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnalyzeResponse,
  ConfirmedCardData,
  ConfirmResponse,
  MeetingContext,
  SuggestResponse,
} from "@meishi/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppConfig } from "./config.ts";
import { GbizinfoRegistry } from "./corporate/gbizinfo.ts";
import { NtaRegistry } from "./corporate/nta.ts";
import { type CorporateRegistry, NullRegistry } from "./corporate/registry.ts";
import { JevDecisionProvider, RuleDecisionProvider } from "./decision/decision.ts";
import type { CardExtractor } from "./extract/cardExtractor.ts";
import { CodexAppServerExtractor } from "./extract/codexAppServer.ts";
import { StubExtractor } from "./extract/stub.ts";
import { KintoneClient } from "./kintone/client.ts";
import { KintoneStore } from "./kintone/kintoneStore.ts";
import { MemoryStore } from "./kintone/memory.ts";
import type { DataStore } from "./kintone/store.ts";
import { normalizeCard } from "./normalize/normalize.ts";
import { identify } from "./pipeline/identify.ts";
import { rankContacts } from "./pipeline/ranking.ts";
import { accessIdentity } from "./security/accessIdentity.ts";
import { accessLog, rateLimit } from "./security/accessLog.ts";

export interface Deps {
  config: AppConfig;
  extractor: CardExtractor;
  store: DataStore;
  registry: CorporateRegistry;
  decider: RuleDecisionProvider | JevDecisionProvider;
}

export function buildDeps(config: AppConfig): Deps {
  const extractor =
    config.cardExtractor === "stub"
      ? new StubExtractor()
      : new CodexAppServerExtractor({
          bin: config.codexBin,
          model: config.codexModel,
          timeoutMs: config.codexTimeoutMs,
        });

  const store =
    config.storeBackend === "kintone"
      ? new KintoneStore(new KintoneClient(config.kintoneBaseUrl), config)
      : new MemoryStore();

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

function sniffImage(buf: Buffer): "jpeg" | "png" | "webp" | null {
  const starts = (magic: number[]) => magic.every((b, i) => buf[i] === b);
  if (starts(JPEG_MAGIC)) return "jpeg";
  if (starts(PNG_MAGIC)) return "png";
  if (starts(WEBP_RIFF) && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

export function createApp(deps: Deps): Hono {
  const app = new Hono();
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
    const buf = Buffer.from(body.image_base64, "base64");
    if (buf.length === 0 || buf.length > config.maxImageBytes) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const kind = sniffImage(buf);
    if (!kind) {
      return c.json({ error: "unsupported_media_type" }, 415);
    }

    // Image retention: written to a private temp dir for the extractor and
    // deleted after processing unless IMAGE_RETENTION=keep.
    const dir = await mkdtempSafe();
    const imagePath = join(dir, `card.${kind === "jpeg" ? "jpg" : kind}`);
    await writeFile(imagePath, buf);
    try {
      const raw = await extractor.extract(imagePath);
      const card = normalizeCard(raw);
      const result: AnalyzeResponse = await identify(card, identifyDeps);
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
    } finally {
      if (config.imageRetention === "ephemeral") {
        await rm(dir, { recursive: true, force: true });
      }
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

    // Duplicate prevention: corporation identity = corporate_number first.
    const corp = await store.getOrCreateCorporation({
      officialName: data.official_name || data.company_name,
      corporateNumber: data.corporate_number,
      address: data.address,
      website: data.website,
      verificationStatus: data.corporate_number ? "verified" : "unverified",
    });
    const contact = await store.getOrCreateContact({
      corporationId: corp.corporationId,
      name: data.person_name,
      department: data.department,
      title: data.title,
      email: data.email,
      phone: data.phone,
      mobile: data.mobile,
    });
    const card = await store.createBusinessCard({
      personId: contact.personId,
      corporationId: corp.corporationId,
      imageReference: data.corporation_id ?? "",
      rawExtraction: data.raw_extraction ?? "",
      confirmedData: JSON.stringify(data),
      decisionConfidence: data.decision_confidence ?? 0,
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
    };
    return c.json(res);
  });

  return app;
}

async function mkdtempSafe(): Promise<string> {
  const dir = join(tmpdir(), `meishi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
