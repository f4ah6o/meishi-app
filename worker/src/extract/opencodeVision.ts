import {
  EXTRACTION_PROMPT,
  parseExtractionJson,
} from "@meishi/server/src/extract/cardExtractor.ts";
import type { BusinessCardExtraction } from "@meishi/shared";

/** Extracts structured card fields from raw image bytes (no filesystem). */
export interface ImageCardExtractor {
  extract(image: { bytes: Uint8Array; mediaType: string }): Promise<BusinessCardExtraction>;
}

export interface OpenCodeVisionOptions {
  /** Base URL of the OpenAI-compatible API, e.g. https://opencode.ai/zen/go/v1. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /**
   * Stable per-app session identifier sent as `x-opencode-session`
   * (OpenCode Go docs ask for a stable session, not per-request random).
   */
  session?: string;
  fetchImpl?: typeof fetch;
}

const USER_AGENT = "meishi-app/0.1 (+https://github.com/f4ah6o/meishi-app)";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Vision extractor over the OpenCode Zen Go OpenAI-compatible chat endpoint:
 *   POST {baseUrl}/chat/completions  (default https://opencode.ai/zen/go/v1)
 * with the card image as a data-URL image content part and the shared
 * JSON-only extraction prompt.
 *
 * Known limitation: Zen Go is documented primarily for coding-agent traffic
 * (https://opencode.ai/docs/go/); whether a given model slug serves raw
 * application workloads depends on the provisioned key. This client treats
 * non-2xx or malformed responses as extraction failures and never fabricates
 * a result.
 */
export class OpenCodeVisionExtractor implements ImageCardExtractor {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenCodeVisionOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async extract(image: { bytes: Uint8Array; mediaType: string }): Promise<BusinessCardExtraction> {
    if (!this.opts.apiKey) {
      throw new Error("OPENCODE_API_KEY is not configured");
    }
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "x-opencode-session": this.opts.session ?? "meishi-app",
        },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: 0,
          // The model spends tokens on reasoning_content before emitting the
          // final JSON — small budgets (e.g. 300) return finish_reason="length"
          // with empty content, so leave ample room for both.
          max_tokens: 2000,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: EXTRACTION_PROMPT },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${image.mediaType};base64,${bytesToBase64(image.bytes)}`,
                  },
                },
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        // Status only — the upstream error body is untrusted and could echo
        // request data; it must not propagate into logs/API responses.
        throw new Error(`OpenCode API failed: ${res.status}`);
      }
      const body = (await res.json()) as {
        choices?: {
          finish_reason?: string;
          message?: { content?: string | { type?: string; text?: string }[] };
        }[];
      };
      const choice = body.choices?.[0];
      // A truncated generation (reasoning consumed the whole token budget)
      // yields empty content — that is an extraction failure, not a result.
      if (choice?.finish_reason === "length") {
        throw new Error("OpenCode API response truncated (finish_reason=length)");
      }
      const content = choice?.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((p) => p?.type === "text" && typeof p.text === "string")
                .map((p) => p.text)
                .join("")
            : "";
      if (!text) {
        throw new Error("OpenCode API returned no message content");
      }
      const card = parseExtractionJson(text);
      // parseExtractionJson fills missing fields with "" — a 200 + `{}` or
      // field-less payload is not an extraction. Require at least one
      // meaningful field before reporting success.
      const meaningful = [
        card.company_name_raw,
        card.person_name,
        card.email,
        card.phone,
        card.mobile,
      ];
      if (!meaningful.some((v) => v.trim().length > 0)) {
        throw new Error("OpenCode extraction contained no usable fields");
      }
      return card;
    } finally {
      clearTimeout(timer);
    }
  }
}
