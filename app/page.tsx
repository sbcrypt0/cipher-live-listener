"use client";

import { useScribe, type TranscriptSegment } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";

type GateResult = {
  should_post: boolean;
  message: string;
  reason?: string;
  at: string;
};

// How much recent transcript to send the LLM each time it's asked to decide.
const WINDOW_SECONDS = 30;
// Don't ask the LLM again sooner than this after a committed segment,
// so it only fires once things have actually settled (a natural pause).
const SILENCE_DEBOUNCE_MS = 3000;
// Hard floor between gate calls even if people keep talking continuously,
// so a busy room doesn't spam the API (or the "chat").
const MIN_GAP_BETWEEN_CALLS_MS = 15000;

// Say this name and it treats the request as directed at it: answers even
// if it would normally have stayed quiet, and skips the usual wait/cooldown
// so it responds promptly instead of waiting for the next natural pause.
// Transcription may spell it Cipher, Cypher, Sypher, Cifer, Syfer...
const WAKE_WORD = "cipher";
const DIRECT_ADDRESS_DEBOUNCE_MS = 800;
// In a noisy room the transcriber never hears a pause, so it never finalises
// a line on its own. If speech has been building up this long without being
// finalised, force it, so Cipher still gets to see it.
const FORCE_COMMIT_MS = 6000;
const WAKE_WORD_PATTERN = /\b[cs][iy](?:ph|f)er\b/i;

export default function Home() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [posts, setPosts] = useState<GateResult[]>([]);
  const [log, setLog] = useState<GateResult[]>([]);
  const [gateBusy, setGateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCallAtRef = useRef<number>(0);
  const lastCommitAtRef = useRef<number>(Date.now());
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const postsRef = useRef<GateResult[]>([]);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  const runGate = useCallback(async (opts?: { directAddress?: boolean }) => {
    const directAddress = opts?.directAddress ?? false;
    const now = Date.now();
    // A direct "hey <wake word>" skips the cooldown — someone asking it
    // something by name shouldn't have to wait out the normal rate limit.
    if (!directAddress && now - lastCallAtRef.current < MIN_GAP_BETWEEN_CALLS_MS) {
      return;
    }
    lastCallAtRef.current = now;

    const cutoff = now / 1000 - WINDOW_SECONDS;
    const windowText = segmentsRef.current
      .filter((s) => s.timestamp >= cutoff)
      .map((s) => s.text)
      .join(" ")
      .trim();

    if (!windowText) return;

    setGateBusy(true);
    try {
      const res = await fetch("/api/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcriptWindow: windowText,
          recentPosts: postsRef.current.slice(-5).map((p) => p.message),
          directAddress,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const result: GateResult = { ...data, at: new Date().toLocaleTimeString() };
      setLog((prev) => [...prev, result]);
      if (result.should_post && result.message) {
        setPosts((prev) => [...prev, result]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "gate request failed");
    } finally {
      setGateBusy(false);
    }
  }, []);

  const scribe = useScribe({
    autoConnect: false,
    modelId: "scribe_v2_realtime",
    // Always transcribe as English; auto-detect sometimes mistakes short
    // clips (e.g. "Cipher") for another language.
    languageCode: "en",
    // Bias the transcriber towards spelling the name correctly.
    keyterms: ["Cipher"],
    microphone: { echoCancellation: true, noiseSuppression: true },
    onCommittedTranscript: (data) => {
      lastCommitAtRef.current = Date.now();
      setSegments((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          text: data.text,
          timestamp: Date.now() / 1000,
          isFinal: true,
        },
      ]);
      // A direct address ("hey cipher, ...") jumps the queue: short debounce,
      // and runGate is told to bypass the normal cooldown too.
      const directAddress = WAKE_WORD_PATTERN.test(data.text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(
        () => runGate(directAddress ? { directAddress: true } : undefined),
        directAddress ? DIRECT_ADDRESS_DEBOUNCE_MS : SILENCE_DEBOUNCE_MS
      );
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Keep the latest draft text and commit function in refs so the timer
  // below always sees current values.
  const partialRef = useRef("");
  const commitRef = useRef(scribe.commit);
  useEffect(() => {
    partialRef.current = scribe.partialTranscript;
  }, [scribe.partialTranscript]);
  useEffect(() => {
    commitRef.current = scribe.commit;
  }, [scribe.commit]);

  useEffect(() => {
    if (!scribe.isConnected) return;
    lastCommitAtRef.current = Date.now();
    const id = setInterval(() => {
      const waiting = Date.now() - lastCommitAtRef.current;
      if (partialRef.current.trim() && waiting >= FORCE_COMMIT_MS) {
        lastCommitAtRef.current = Date.now();
        commitRef.current();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [scribe.isConnected]);

  const start = async () => {
    setError(null);
    try {
      const res = await fetch("/api/scribe-token");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await scribe.connect({ token: data.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start");
    }
  };

  const stop = () => {
    scribe.disconnect();
    if (debounceRef.current) clearTimeout(debounceRef.current);
  };

  const live = scribe.isConnected;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Cipher</h1>
            <p className="text-neutral-400 text-sm">
              Listening in · speaks up only when it has something worth adding
              · say &ldquo;Cipher&rdquo; to ask it directly
            </p>
          </div>

          <div className="flex items-center gap-4">
            <span className="flex items-center gap-2 text-sm font-medium">
              <span className="relative flex h-3 w-3">
                {live && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                )}
                <span
                  className={`relative inline-flex h-3 w-3 rounded-full ${
                    live ? "bg-red-500" : "bg-neutral-600"
                  }`}
                />
              </span>
              {live ? "Listening" : "Not listening"}
              {gateBusy && (
                <span className="text-neutral-400 font-normal">· thinking…</span>
              )}
            </span>
            {!live ? (
              <button
                onClick={start}
                className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-semibold"
              >
                Start listening
              </button>
            ) : (
              <button
                onClick={stop}
                className="px-5 py-2.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 font-semibold"
              >
                Stop
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="text-sm text-red-300 border border-red-900 bg-red-950/40 rounded-lg p-3">
            {error}
          </div>
        )}

        <section className="space-y-4">
          {posts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-800 p-10 text-center text-neutral-500 text-lg">
              Nothing yet — Cipher stays quiet unless it has something worth
              adding.
            </div>
          ) : (
            <ul className="space-y-4">
              {[...posts].reverse().map((p, i) => (
                <li
                  key={posts.length - i}
                  className={`rounded-xl border p-6 ${
                    i === 0
                      ? "border-emerald-700 bg-emerald-950/40"
                      : "border-neutral-800 bg-neutral-900/60 opacity-70"
                  }`}
                >
                  <p className={i === 0 ? "text-2xl leading-snug" : "text-lg leading-snug"}>
                    {p.message}
                  </p>
                  <p className="text-xs text-neutral-500 mt-3">Cipher · {p.at}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Live transcript
          </h2>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 max-h-32 overflow-y-auto text-xs text-neutral-400 space-y-1">
            {segments.length === 0 && <p className="text-neutral-600">…</p>}
            {segments.map((s) => (
              <p key={s.id}>{s.text}</p>
            ))}
            {scribe.partialTranscript && (
              <p className="text-neutral-500 italic">{scribe.partialTranscript}</p>
            )}
          </div>
        </section>

        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-500">
            Decision log ({log.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {[...log].reverse().map((l, i) => (
              <li
                key={i}
                className="rounded-md border border-neutral-800 p-2 text-xs text-neutral-400"
              >
                <span className={l.should_post ? "text-emerald-400" : "text-neutral-500"}>
                  {l.should_post ? "posted" : "stayed quiet"}
                </span>{" "}
                · {l.at} · {l.reason}
              </li>
            ))}
          </ul>
        </details>
      </main>
    </div>
  );
}
