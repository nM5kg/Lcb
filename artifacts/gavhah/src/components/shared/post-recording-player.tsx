// Player for a post's attached recording (Yakob 2026-11-20): a
// hotline-opened discussion and any post with a recording carry it here,
// so the recording is never hidden on the website. The audio endpoint
// serves a published recording to anyone; a pending one only to its
// author or staff (recordingStatus is null for everyone else).
// The status arrives as a plain string from the API client, so the prop
// takes a string and only the three known values render a player.
// When canReview is true (an admin on the detail page), the admin can
// approve or reject a pending recording, or re-send a published one to
// Yemot (a published recording with no Yemot path plays as text until
// it is approved again — e.g. article 17).
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function PostRecordingPlayer({
  postType,
  postId,
  recordingStatus,
  canReview,
}: {
  postType: "news" | "discussion";
  postId: number;
  recordingStatus: string | null | undefined;
  canReview?: boolean;
}) {
  const [status, setStatus] = useState<string | null | undefined>(recordingStatus);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (status !== "published" && status !== "pending" && status !== "rejected") return null;
  const what = postType === "news" ? "update" : "discussion";
  async function review(action: "approve" | "reject") {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/post-audio/${postType}/${postId}/review`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote("עס איז נישט געגאַנגען: " + (data.error || res.status));
        return;
      }
      if (action === "approve") {
        setStatus("published");
        setNote("אַפּרוווט — די רעקאָרדירונג גייט אַרויף צו ימות און וועט שפּילן אויפֿן לײַן.");
      } else {
        setStatus("rejected");
        setNote("אָפּגעוואָרפֿן.");
      }
    } catch {
      setNote("עס איז נישט געגאַנגען — פּרובירט נאָכאַמאָל.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-6 rounded-xl border bg-muted/20 p-4" aria-label="Recording">
      <h2 className="font-semibold mb-1">Recording</h2>
      {status === "published" ? (
        <>
          <p className="text-sm text-muted-foreground mb-3">
            Listen to the recording for this {what} — this is the recording that plays on the hotline.
          </p>
          <audio controls preload="none" className="w-full" src={`/api/${postType}/${postId}/audio`}>
            Your browser does not support audio.
          </audio>
        </>
      ) : status === "pending" ? (
        <>
          <p className="text-sm text-muted-foreground mb-3">
            A recording is attached and waits for review before it reaches the hotline.
          </p>
          <audio controls preload="none" className="w-full" src={`/api/${postType}/${postId}/audio`}>
            Your browser does not support audio.
          </audio>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">The recording was not approved.</p>
      )}
      {canReview && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status === "pending" && (
            <>
              <Button size="sm" disabled={busy} onClick={() => review("approve")}>
                אַפּרווו
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => review("reject")}>
                אָפּוואַרפֿן
              </Button>
            </>
          )}
          {status === "published" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => review("approve")}>
              שיק ווידער צו ימות
            </Button>
          )}
          {status === "rejected" && (
            <Button size="sm" disabled={busy} onClick={() => review("approve")}>
              אַפּרווו
            </Button>
          )}
          {note && <span className="text-sm text-muted-foreground">{note}</span>}
        </div>
      )}
    </section>
  );
}
