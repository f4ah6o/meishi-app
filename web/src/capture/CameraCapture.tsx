import { useCallback, useEffect, useRef, useState } from "react";
import { assessFrame, DEFAULT_THRESHOLDS, type Quad, quadDisplacement } from "./cardDetect.ts";
import { type RgbaImage, rectifyCard } from "./perspective.ts";

const ANALYSIS_W = 192;
const ANALYSIS_H = 144;
/** Spec default: 500ms〜1s of stability before auto-capture. */
const STABLE_MS = 800;
const MAX_DISPLACEMENT = 3; // analysis-grid px

interface Props {
  onCapture: (dataUrl: string) => void;
  busy: boolean;
}

export function CameraCapture({ onCapture, busy }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"starting" | "scanning" | "error">("starting");
  const [reasons, setReasons] = useState<string[]>([]);
  const [stability, setStability] = useState(0);
  const [quad, setQuad] = useState<Quad | null>(null);
  const stable = useRef<{ quad: Quad | null; since: number }>({ quad: null, since: 0 });
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          void video.play().then(() => setPhase("scanning"));
        }
      })
      .catch(() => setPhase("error"));
    return () => {
      cancelled = true;
      for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    };
  }, []);

  const captureFromVideo = useCallback((rectify: boolean): string | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);

    if (rectify && stable.current.quad) {
      const scale = canvas.width / ANALYSIS_W;
      const q = stable.current.quad;
      const scaled: Quad = {
        corners: q.corners.map((p) => ({
          x: p.x * scale,
          y: p.y * (canvas.height / ANALYSIS_H),
        })) as Quad["corners"],
        area: q.area,
      };
      const image: RgbaImage = {
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        width: canvas.width,
        height: canvas.height,
      };
      const rect = rectifyCard(image, scaled);
      const out = document.createElement("canvas");
      out.width = rect.width;
      out.height = rect.height;
      const outCtx = out.getContext("2d");
      if (outCtx) {
        outCtx.putImageData(new ImageData(rect.data, rect.width, rect.height), 0, 0);
        return out.toDataURL("image/jpeg", 0.9);
      }
    }
    return canvas.toDataURL("image/jpeg", 0.9);
  }, []);

  // Analysis loop: no video frames leave the device — only the final JPEG.
  useEffect(() => {
    if (phase !== "scanning") return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 120 || busy) return;
      last = now;
      const video = videoRef.current;
      const canvas = analysisCanvasRef.current;
      if (!video || !canvas || video.videoWidth === 0) return;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
      const img = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
      const gray = new Uint8Array(ANALYSIS_W * ANALYSIS_H);
      for (let i = 0; i < gray.length; i++) {
        const o = i * 4;
        gray[i] = (img.data[o]! * 77 + img.data[o + 1]! * 150 + img.data[o + 2]! * 29) >> 8;
      }
      const result = assessFrame(gray, ANALYSIS_W, ANALYSIS_H, DEFAULT_THRESHOLDS);
      setQuad(result.quad);

      if (result.ok && result.quad) {
        const prev = stable.current.quad;
        const moved = prev ? quadDisplacement(prev, result.quad) : Infinity;
        if (moved <= MAX_DISPLACEMENT && stable.current.since > 0) {
          const elapsed = now - stable.current.since;
          setStability(Math.min(1, elapsed / STABLE_MS));
          if (elapsed >= STABLE_MS) {
            const url = captureFromVideo(true);
            stable.current.since = 0;
            if (url) onCapture(url);
            return;
          }
        } else {
          stable.current = { quad: result.quad, since: now };
          setStability(0);
        }
        setReasons([]);
      } else {
        stable.current = { quad: null, since: 0 };
        setStability(0);
        setReasons(result.reasons);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, busy, captureFromVideo, onCapture]);

  return (
    <div className="capture">
      <div className="viewport">
        <video ref={videoRef} playsInline muted />
        <canvas ref={analysisCanvasRef} width={ANALYSIS_W} height={ANALYSIS_H} hidden />
        {quad && (
          <svg
            className="overlay"
            viewBox={`0 0 ${ANALYSIS_W} ${ANALYSIS_H}`}
            preserveAspectRatio="none"
          >
            <title>detected card outline</title>
            <polygon
              points={quad.corners.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={stability > 0 ? "#34d399" : "#fbbf24"}
              strokeWidth={1.5}
            />
          </svg>
        )}
        {stability > 0 && <div className="stable-bar" style={{ width: `${stability * 100}%` }} />}
      </div>
      <div className="status">
        {phase === "starting" && "カメラを起動しています…"}
        {phase === "error" && "カメラを起動できません。下のボタンから写真を選んでください。"}
        {phase === "scanning" &&
          (reasons.length > 0
            ? reasons[0]
            : stability > 0
              ? "そのまま保持…"
              : "名刺を検出しました")}
      </div>
      <button
        type="button"
        className="shutter"
        disabled={busy || phase === "error"}
        onClick={() => {
          const url = captureFromVideo(true) ?? captureFromVideo(false);
          if (url) onCapture(url);
        }}
      >
        {busy ? "解析中…" : "撮影"}
      </button>
      <label className="file-fallback">
        写真から選ぶ
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === "string") onCapture(reader.result);
            };
            reader.readAsDataURL(f);
          }}
        />
      </label>
    </div>
  );
}
