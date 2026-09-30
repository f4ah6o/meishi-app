import type { AnalyzeResponse, ConfirmedCardData, ContactCandidate } from "@meishi/shared";
import { useEffect, useMemo, useState } from "react";
import { confirmCard, recentContacts } from "../api.ts";
import { localDateString } from "../lib/localDate.ts";

interface Props {
  analysis: AnalyzeResponse;
  onRegistered: (personId: string) => void;
  onSelectContact: (personId: string) => void;
  onRetake: () => void;
}

const FIELDS: { key: keyof ConfirmedCardData; label: string }[] = [
  { key: "person_name", label: "氏名" },
  { key: "company_name", label: "会社名" },
  { key: "department", label: "部署" },
  { key: "title", label: "役職" },
  { key: "email", label: "メール" },
  { key: "phone", label: "電話" },
  { key: "mobile", label: "携帯" },
  { key: "postal_code", label: "郵便番号" },
  { key: "address", label: "住所" },
  { key: "website", label: "Webサイト" },
];

export function ConfirmView({ analysis, onRegistered, onSelectContact, onRetake }: Props) {
  const [form, setForm] = useState<Record<string, string>>(() => ({
    person_name: analysis.extraction.person_name,
    company_name: analysis.extraction.company_name,
    department: analysis.extraction.department,
    title: analysis.extraction.title,
    email: analysis.extraction.email,
    phone: analysis.extraction.phone,
    mobile: analysis.extraction.mobile,
    postal_code: analysis.extraction.postal_code,
    address: analysis.extraction.address,
    website: analysis.extraction.website,
  }));
  const [selectedCorp, setSelectedCorp] = useState<string>(() =>
    analysis.auto_confirmable && analysis.decision.choice !== "none"
      ? analysis.decision.choice
      : "",
  );
  const [meeting, setMeeting] = useState({ summary: "", next_action: "", type: "meeting" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ContactCandidate[]>([]);

  // Early suggestion of existing contacts / repeat meetings.
  useEffect(() => {
    if (analysis.existing_contacts.length > 0) {
      setSuggestions(analysis.existing_contacts);
      return;
    }
    recentContacts({
      company: analysis.extraction.company_name_key,
      person: analysis.extraction.person_name,
    })
      .then((r) => setSuggestions(r.contacts))
      .catch(() => {});
  }, [analysis]);

  const uncertain = useMemo(() => new Set(analysis.extraction.uncertain_fields), [analysis]);

  const chosenCorp = analysis.corporate_candidates.find((c) => c.corporate_number === selectedCorp);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const data: ConfirmedCardData = {
        ...(form as unknown as ConfirmedCardData),
        official_name: chosenCorp?.official_name ?? form.company_name,
        corporate_number: chosenCorp?.corporate_number || undefined,
        raw_extraction: JSON.stringify(analysis.raw),
        decision_confidence: analysis.decision.confidence,
        meeting: meeting.summary
          ? {
              interaction_type: meeting.type,
              interaction_at: localDateString(),
              summary: meeting.summary,
              next_action: meeting.next_action,
            }
          : undefined,
      };
      const res = await confirmCard(data);
      onRegistered(res.person_id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="confirm">
      {suggestions.length > 0 && (
        <section className="card suggestion">
          <h2>今回のお相手はこちらですか？</h2>
          {suggestions.slice(0, 3).map((ct) => (
            <div key={ct.person_id} className="contact-hit">
              <div>
                <strong>{ct.official_name}</strong>
                <div>
                  {ct.name} {ct.title}
                </div>
                {ct.last_interaction_at && (
                  <div className="muted">最終商談: {ct.last_interaction_at.slice(0, 10)}</div>
                )}
              </div>
              <button type="button" onClick={() => onSelectContact(ct.person_id)}>
                この方で開始
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>名刺の内容を確認</h2>
        {FIELDS.map(({ key, label }) => (
          <label key={key} className={`field ${uncertain.has(key) ? "uncertain" : ""}`}>
            <span>
              {label}
              {uncertain.has(key) ? " ⚠" : ""}
            </span>
            <input
              value={form[key as string] ?? ""}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </label>
        ))}
      </section>

      <section className="card">
        <h2>法人の特定</h2>
        {analysis.decision.choice !== "none" && (
          <div className="muted">
            AI判定: {analysis.decision.choice} (confidence {analysis.decision.confidence.toFixed(2)}
            ){analysis.auto_confirmable ? " — 自動確定可能" : " — 要確認"}
            {analysis.decision.rationale ? ` (${analysis.decision.rationale})` : ""}
          </div>
        )}
        {analysis.corporate_candidates.length === 0 && (
          <div className="muted">
            法人候補が見つかりませんでした。未確認の法人として登録されます。
          </div>
        )}
        {analysis.corporate_candidates.map((c) => (
          <label key={`${c.source}-${c.corporate_number}`} className="corp-option">
            <input
              type="radio"
              name="corp"
              checked={selectedCorp === c.corporate_number}
              onChange={() => setSelectedCorp(c.corporate_number)}
            />
            <span>
              <strong>{c.official_name}</strong> ({c.source === "kintone" ? "既存" : c.source})
              <br />
              法人番号: {c.corporate_number}
              {c.address ? ` — ${c.address}` : ""}
            </span>
          </label>
        ))}
        {analysis.corporate_candidates.length > 0 && (
          <label className="corp-option">
            <input
              type="radio"
              name="corp"
              checked={selectedCorp === ""}
              onChange={() => setSelectedCorp("")}
            />
            <span>該当なし（法人番号なしで登録）</span>
          </label>
        )}
      </section>

      <section className="card">
        <h2>商談メモ（任意）</h2>
        <textarea
          placeholder="商談内容"
          value={meeting.summary}
          onChange={(e) => setMeeting({ ...meeting, summary: e.target.value })}
        />
        <input
          placeholder="次のアクション"
          value={meeting.next_action}
          onChange={(e) => setMeeting({ ...meeting, next_action: e.target.value })}
        />
      </section>

      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button type="button" onClick={onRetake} disabled={submitting}>
          撮り直す
        </button>
        <button type="button" className="primary" onClick={submit} disabled={submitting}>
          {submitting ? "登録中…" : "確認して登録"}
        </button>
      </div>
    </div>
  );
}
