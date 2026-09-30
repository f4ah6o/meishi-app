import type { MeetingContext } from "@meishi/shared";

export function ContextView({ ctx, onDone }: { ctx: MeetingContext; onDone: () => void }) {
  const { contact, recent_interactions } = ctx;
  const last = recent_interactions[0];
  return (
    <div className="context card">
      <h2>{contact.name}</h2>
      <div className="muted">
        {contact.official_name} {contact.department} {contact.title}
      </div>
      {last && (
        <>
          <h3>前回</h3>
          <div>{last.summary || last.interaction_type}</div>
          {last.next_action && (
            <>
              <h3>前回の確認事項</h3>
              <div>{last.next_action}</div>
            </>
          )}
          <div className="muted">最終接触: {last.interaction_at.slice(0, 10)}</div>
        </>
      )}
      {recent_interactions.length > 1 && (
        <>
          <h3>履歴</h3>
          <ul>
            {recent_interactions.slice(1).map((i) => (
              <li key={i.interaction_id}>
                {i.interaction_at.slice(0, 10)} — {i.summary || i.interaction_type}
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" className="primary" onClick={onDone}>
        完了
      </button>
    </div>
  );
}
