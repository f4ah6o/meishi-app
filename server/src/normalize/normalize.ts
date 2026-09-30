import type { BusinessCardExtraction, NormalizedCard } from "@meishi/shared";

/**
 * Deterministic normalization — the spec requires that everything which can be
 * normalized with normal code is done here rather than by the AI.
 */

export function nfkc(value: string): string {
  return value.normalize("NFKC");
}

export function collapseWhitespace(value: string): string {
  return nfkc(value)
    .replace(/[\s　]+/g, " ")
    .trim();
}

const LEGAL_FORMS: { pattern: RegExp; canonical: string }[] = [
  { pattern: /株式会社|（株）|\(株\)|㈱|㈴/g, canonical: "株式会社" },
  { pattern: /有限会社|（有）|\(有\)|㈳/g, canonical: "有限会社" },
  { pattern: /合同会社|（同）|\(同\)/g, canonical: "合同会社" },
  { pattern: /合資会社|（資）|\(資\)/g, canonical: "合資会社" },
  { pattern: /合名会社|（名）|\(名\)/g, canonical: "合名会社" },
];

/**
 * Canonicalize Japanese legal-form notation:
 *   （株）山田建設 / ㈱山田建設 / 山田建設（株） -> 株式会社山田建設
 */
export function normalizeCompanyName(raw: string): string {
  const s = collapseWhitespace(raw).replace(/\s+/g, "");
  for (const { pattern, canonical } of LEGAL_FORMS) {
    pattern.lastIndex = 0;
    if (pattern.test(s)) {
      // Move the legal form to the front: 山田建設（株） -> 株式会社山田建設
      const core = s.replace(pattern, "");
      return canonical + core;
    }
  }
  return s;
}

/**
 * Lookup key for matching: strip the legal form entirely so that
 * 株式会社山田建設 and 山田建設（株） compare equal.
 */
export function companyNameKey(name: string): string {
  let s = normalizeCompanyName(name);
  for (const { canonical } of LEGAL_FORMS) {
    s = s.split(canonical).join("");
  }
  return s.replace(/[\s・]/g, "");
}

/** 〒123-4567 / 1234567 / １２３−４５６７ -> 123-4567 (or "" if invalid). */
export function normalizePostalCode(raw: string): string {
  const digits = nfkc(raw).replace(/[^0-9]/g, "");
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return "";
}

/**
 * Normalize a Japanese phone number to hyphenated digit groups.
 * Keeps a leading "+" for international numbers. Returns "" when implausible.
 */
export function normalizePhone(raw: string): string {
  let s = nfkc(raw).replace(/[（(]/g, "-").replace(/[）)]/g, "-");
  s = s.replace(/[^0-9+-]/g, "");
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/-/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
  }
  const digits = s.replace(/-/g, "");
  if (!/^0\d{9,10}$/.test(digits)) return digits.length >= 10 ? digits : "";
  if (/^0[57-9]0\d{8}$/.test(digits)) {
    // mobile / IP phone (070/080/090/050): 3-4-4
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  if (/^0[36]\d{8}$/.test(digits)) {
    // Tokyo (03) / Osaka (06): the only 2-digit area codes — 2-4-4
    return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  // Japanese area codes vary 2–5 digits; when we cannot restore the correct
  // split, keep the digits rather than hyphenating wrongly.
  return digits;
}

export function normalizeEmail(raw: string): string {
  return nfkc(raw).trim().toLowerCase().replace(/\s+/g, "");
}

export function normalizeWebsite(raw: string): string {
  let s = nfkc(raw).trim().replace(/\s+/g, "");
  if (!s) return "";
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  try {
    const url = new URL(s);
    url.hostname = url.hostname.toLowerCase();
    url.protocol = url.protocol.toLowerCase();
    return url.toString();
  } catch {
    return s;
  }
}

/** Domain derived from the website, or from the email address as a fallback. */
export function extractDomain(website: string, email: string): string | null {
  if (website) {
    try {
      const host = new URL(normalizeWebsite(website)).hostname;
      return host.replace(/^www\./, "");
    } catch {
      /* fall through to email */
    }
  }
  const at = email.indexOf("@");
  if (at > 0) {
    const domain = email.slice(at + 1).toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return domain;
  }
  return null;
}

export function normalizeCard(raw: BusinessCardExtraction): NormalizedCard {
  const email = normalizeEmail(raw.email);
  const website = normalizeWebsite(raw.website);
  return {
    ...raw,
    company_name_raw: collapseWhitespace(raw.company_name_raw),
    person_name: collapseWhitespace(raw.person_name),
    department: collapseWhitespace(raw.department),
    title: collapseWhitespace(raw.title),
    postal_code: normalizePostalCode(raw.postal_code),
    address: collapseWhitespace(raw.address),
    phone: normalizePhone(raw.phone),
    mobile: normalizePhone(raw.mobile),
    fax: normalizePhone(raw.fax),
    email,
    website,
    company_name: normalizeCompanyName(raw.company_name_raw),
    company_name_key: companyNameKey(raw.company_name_raw),
    domain: extractDomain(website, email),
  };
}
