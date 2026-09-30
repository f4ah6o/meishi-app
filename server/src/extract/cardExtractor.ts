import type { BusinessCardExtraction } from "@meishi/shared";

/**
 * CardExtractor abstracts the AI layer so Codex app-server can later be swapped
 * for a metered Vision API (OpenAIExtractor / GeminiExtractor / ClaudeExtractor).
 */
export interface CardExtractor {
  /** Extract structured fields from a card image stored at `imagePath`. */
  extract(imagePath: string): Promise<BusinessCardExtraction>;
}

export const EXTRACTION_PROMPT = `あなたは名刺OCRアシスタントです。添付された名刺画像を読み取り、以下のJSONオブジェクト「のみ」を出力してください。説明・コードフェンス・前置きは一切不要です。

{
  "company_name_raw": "名刺に印刷されている会社名をそのまま（㈱・（株）などの表記もそのまま）",
  "person_name": "氏名",
  "department": "部署名",
  "title": "役職",
  "postal_code": "郵便番号",
  "address": "住所",
  "phone": "代表電話・直通電話",
  "mobile": "携帯電話",
  "fax": "FAX番号",
  "email": "メールアドレス",
  "website": "会社のWebサイトURL",
  "uncertain_fields": ["読み取りに自信がないフィールド名の配列"]
}

ルール:
- 読み取れない項目は空文字にする
- uncertain_fields には判読が曖昧なフィールド名を入れる（例: "mobile"）
- 出力は上記キーのみを持つJSONオブジェクト1つ`;

const KNOWN_FIELDS = [
  "company_name_raw",
  "person_name",
  "department",
  "title",
  "postal_code",
  "address",
  "phone",
  "mobile",
  "fax",
  "email",
  "website",
] as const;

/**
 * Pull a JSON object out of an agent message: strips optional code fences and
 * surrounding prose, then validates every expected key.
 */
export function parseExtractionJson(text: string): BusinessCardExtraction {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("extractor output did not contain a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new Error(`extractor output was not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("extractor output was not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of KNOWN_FIELDS) {
    const v = obj[field];
    out[field] = typeof v === "string" ? v : v == null ? "" : String(v);
  }
  const uncertain = obj.uncertain_fields;
  out.uncertain_fields = Array.isArray(uncertain)
    ? uncertain.filter((v): v is string => typeof v === "string")
    : [];
  return out as unknown as BusinessCardExtraction;
}
