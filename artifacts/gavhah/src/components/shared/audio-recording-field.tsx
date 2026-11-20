// Optional recording field for a news update or a discussion (Yakob
// 2026-11-20): record with the device microphone (MediaRecorder) or
// choose an audio file, preview it, re-record, or remove it. The parent
// keeps the {mime, base64} value and uploads it AFTER the post is
// created (POST /api/news/:id/audio or /api/discussions/:id/audio).
// The recording waits for review before it reaches the hotline.
import { useEffect, useRef, useState } from "react";
import { Mic, Square, Upload, Trash2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type AudioRecordingValue = { mime: string; base64: string } | null;
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

// Upload a recording attached in a post form, after the post exists
// (it needs the id). The recording waits for review before it reaches
// the hotline.
export async function uploadPostRecording(
  postType: "news" | "discussion",
  postId: number,
  recording: NonNullable<AudioRecordingValue>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/${postType}/${postId}/audio`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mime: recording.mime, base64: recording.base64 }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: String(body.error || "Could not attach recording") };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not attach recording" };
  }
}

async function asBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(Error("Audio file could not be read"));
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.readAsDataURL(blob);
  });
}

export function AudioRecordingField({
  value,
  onChange,
  label = "Recording (optional)",
}: {
  value: AudioRecordingValue;
  onChange: (value: AudioRecordingValue) => void;
  label?: string;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [active, setActive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
      recorder.current?.state === "recording" && recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  useEffect(() => {
    if (!blob) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const setAudio = async (next: Blob | null) => {
    setBlob(next);
    setError("");
    if (!next) {
      onChange(null);
      return;
    }
    if (next.size < 80 || next.size > MAX_AUDIO_BYTES) {
      setError("Recording must be between 80 bytes and 4 MB.");
      setBlob(null);
      onChange(null);
      return;
    }
    setBusy(true);
    try {
      const base64 = await asBase64(next);
      if (!base64) throw Error("Audio file could not be read");
      onChange({ mime: next.type || "audio/webm", base64 });
    } catch {
      setError("Audio file could not be read. Please try again.");
      setBlob(null);
      onChange(null);
    } finally {
      setBusy(false);
    }
  };

  const stopTimer = () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };
  const startMic = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError("This browser does not support microphone recording. Use Chrome on HTTPS, or upload an audio file.");
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      stream.current = media;
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((x) =>
        MediaRecorder.isTypeSupported(x)
      );
      const rec = new MediaRecorder(media, type ? { mimeType: type } : undefined);
      const parts: BlobPart[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data);
      };
      rec.onstop = () => {
        void setAudio(new Blob(parts, { type: rec.mimeType || "audio/webm" }));
        media.getTracks().forEach((t) => t.stop());
        stream.current = null;
        setActive(false);
        stopTimer();
      };
      rec.onerror = () => {
        setError("Recording failed. Please try again.");
        setActive(false);
        stopTimer();
      };
      recorder.current = rec;
      rec.start(1000);
      startedAt.current = Date.now();
      setSeconds(0);
      setActive(true);
      timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    } catch {
      setError("Microphone is not allowed. Allow microphone access for this site, then try again.");
    }
  };
  const stopMic = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };
  const pickFile = async (file?: File) => {
    if (!file) return;
    setError("");
    if (file.size > MAX_AUDIO_BYTES) {
      setError("Audio file is too large (max 4 MB).");
      return;
    }
    await setAudio(file);
    if (fileRef.current) fileRef.current.value = "";
  };

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const sizeKb = blob ? (blob.size / 1024).toFixed(0) + " KB" : "";

  return (
    <div className="space-y-2">
      <Label className="font-semibold">{label}</Label>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.webm,.m4a"
        className="hidden"
        onChange={(e) => void pickFile(e.target.files?.[0])}
      />
      {!blob && !active && (
        <div className="rounded-xl border bg-muted/20 p-3">
          <p className="text-sm text-muted-foreground mb-3">
            Speak the update in with your microphone, or upload an audio file. The recording is
            optional — it waits for review before it reaches the hotline.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void startMic()} disabled={busy}>
              <Mic className="h-4 w-4 mr-1" /> Record with microphone
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              <Upload className="h-4 w-4 mr-1" /> Choose an audio file
            </Button>
          </div>
        </div>
      )}
      {active && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-700 mb-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-600 mr-2 animate-pulse" />
            Recording… {mmss}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={stopMic}>
            <Square className="h-4 w-4 mr-1" /> Stop recording
          </Button>
        </div>
      )}
      {blob && !active && (
        <div className="rounded-xl border bg-muted/20 p-3 space-y-2">
          <audio controls preload="none" className="w-full" src={previewUrl}>
            Your browser does not support audio.
          </audio>
          <p className="text-xs text-muted-foreground">
            Recording ready ({sizeKb}){value ? "" : busy ? " — preparing…" : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void startMic()} disabled={busy}>
              <RotateCcw className="h-4 w-4 mr-1" /> Re-record
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              <Upload className="h-4 w-4 mr-1" /> Choose a different file
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => void setAudio(null)}
              disabled={busy}
            >
              <Trash2 className="h-4 w-4 mr-1" /> Remove
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
