import type {
  AnalyzeResponse,
  ApiError,
  ConfirmedCardData,
  ConfirmResponse,
  MeetingContext,
  SuggestResponse,
} from "@meishi/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiError;
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function analyzeCard(imageDataUrl: string): Promise<AnalyzeResponse> {
  const base64 = imageDataUrl.slice(imageDataUrl.indexOf(",") + 1);
  return request<AnalyzeResponse>("/api/cards/analyze", {
    method: "POST",
    body: JSON.stringify({ image_base64: base64 }),
  });
}

export function confirmCard(data: ConfirmedCardData): Promise<ConfirmResponse> {
  return request<ConfirmResponse>("/api/cards/confirm", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function suggestContacts(q: string): Promise<SuggestResponse> {
  return request<SuggestResponse>(`/api/contacts/suggest?q=${encodeURIComponent(q)}`);
}

export function recentContacts(params: {
  company?: string;
  person?: string;
}): Promise<SuggestResponse> {
  const sp = new URLSearchParams();
  if (params.company) sp.set("company", params.company);
  if (params.person) sp.set("person", params.person);
  return request<SuggestResponse>(`/api/contacts/recent?${sp}`);
}

export function contactContext(personId: string): Promise<MeetingContext> {
  return request<MeetingContext>(`/api/contacts/${encodeURIComponent(personId)}/context`);
}
