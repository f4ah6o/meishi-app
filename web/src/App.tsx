import type { AnalyzeResponse, MeetingContext } from "@meishi/shared";
import { useCallback, useState } from "react";
import { analyzeCard, contactContext } from "./api.ts";
import { CameraCapture } from "./capture/CameraCapture.tsx";
import { ConfirmView } from "./views/ConfirmView.tsx";
import { ContextView } from "./views/ContextView.tsx";

type Screen =
  | { name: "capture" }
  | { name: "analyzing" }
  | { name: "confirm"; analysis: AnalyzeResponse }
  | { name: "context"; ctx: MeetingContext };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "capture" });
  const [error, setError] = useState<string | null>(null);

  const onCapture = useCallback(async (dataUrl: string) => {
    setScreen({ name: "analyzing" });
    setError(null);
    try {
      const analysis = await analyzeCard(dataUrl);
      setScreen({ name: "confirm", analysis });
    } catch (e) {
      setError(`解析に失敗しました: ${String(e)}`);
      setScreen({ name: "capture" });
    }
  }, []);

  const showContext = useCallback(async (personId: string) => {
    try {
      const ctx = await contactContext(personId);
      setScreen({ name: "context", ctx });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return (
    <main>
      <header>
        <h1>名刺キャプチャ</h1>
      </header>
      {error && <div className="error">{error}</div>}
      {screen.name === "capture" && <CameraCapture onCapture={onCapture} busy={false} />}
      {screen.name === "analyzing" && <div className="card">AIで名刺を解析しています…</div>}
      {screen.name === "confirm" && (
        <ConfirmView
          analysis={screen.analysis}
          onRetake={() => setScreen({ name: "capture" })}
          onRegistered={showContext}
          onSelectContact={showContext}
        />
      )}
      {screen.name === "context" && (
        <ContextView ctx={screen.ctx} onDone={() => setScreen({ name: "capture" })} />
      )}
    </main>
  );
}
