"use client";

import { useScribe } from "@elevenlabs/react";
import {
  enableDiarization,
  listenForSpeakers,
  speakerLabel,
  toSpeakerRuns,
  type DiarizedWord,
  type SpeakerRun,
} from "./lib/diarization";
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

// Label who said what (needs scribe_v3_live). Set to false to switch it off,
// e.g. if you need ElevenLabs' background-noise filter, which can't be used
// at the same time as speaker labels.
const ENABLE_DIARIZATION = true;

/** One finalised line of transcript. */
type Segment = {
  id: string;
  text: string;
  timestamp: number; // seconds
  segmentIndex?: number; // ElevenLabs' number for this line, links it to its speaker labels
};

type Line = { speaker?: string | null; text: string };

const SPEAKER_COLOURS = [
  "text-sky-300",
  "text-amber-300",
  "text-fuchsia-300",
  "text-lime-300",
  "text-rose-300",
  "text-teal-300",
];

function speakerColour(speaker: string | null): string {
  if (!speaker) return "text-neutral-400";
  const n = Number(speaker.replace(/\D/g, ""));
  return SPEAKER_COLOURS[(Number.isFinite(n) ? n : 0) % SPEAKER_COLOURS.length];
}

/** Speaker runs for a line, or null if its labels haven't arrived (yet). */
function runsFor(
  segment: Segment,
  words: Record<number, DiarizedWord[]>,
  merges: Record<string, string>
): SpeakerRun[] | null {
  if (segment.segmentIndex === undefined) return null;
  const w = words[segment.segmentIndex];
  if (!w) return null;
  const runs = toSpeakerRuns(w, merges);
  return runs.length > 0 ? runs : null;
}

/**
 * Turn transcript lines into the text Cipher reads, e.g.
 *   Speaker 1: Is Python faster than C#?
 *   Speaker 2: No, C# is usually faster.
 * Lines without labels are passed through as plain text.
 */
function toWindowText(
  segments: Segment[],
  words: Record<number, DiarizedWord[]>,
  merges: Record<string, string>
): string {
  const lines: Line[] = [];
  for (const seg of segments) {
    const runs = runsFor(seg, words, merges);
    const parts: Line[] = runs ?? [{ text: seg.text }];
    for (const part of parts) {
      const last = lines[lines.length - 1];
      // Join back-to-back lines from the same labelled speaker.
      if (last && part.speaker !== undefined && last.speaker === part.speaker) {
        last.text += " " + part.text;
      } else {
        lines.push({ ...part });
      }
    }
  }
  return lines
    .map((l) => (l.speaker !== undefined ? `${speakerLabel(l.speaker)}: ${l.text}` : l.text))
    .join("\n")
    .trim();
}

export default function Home() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [posts, setPosts] = useState<GateResult[]>([]);
  const [log, setLog] = useState<GateResult[]>([]);
  const [gateBusy, setGateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Speaker labels, keyed by ElevenLabs' line number (segment_index).
  const [wordsBySegment, setWordsBySegment] = useState<Record<number, DiarizedWord[]>>({});
  // "speaker_2 turned out to be speaker_0" corrections from ElevenLabs.
  const [merges, setMerges] = useState<Record<string, string>>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCallAtRef = useRef<number>(0);
  const lastCommitAtRef = useRef<number>(Date.now());
  const segmentsRef = useRef<Segment[]>([]);
  const postsRef = useRef<GateResult[]>([]);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  const wordsRef = useRef<Record<number, DiarizedWord[]>>({});
  const mergesRef = useRef<Record<string, string>>({});
  const stopSpeakersRef = useRef<() => void>(() => {});
  useEffect(() => {
    wordsRef.current = wordsBySegment;
  }, [wordsBySegment]);
  useEffect(() => {
    mergesRef.current = merges;
  }, [merges]);

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
    const windowText = toWindowText(
      segmentsRef.current.filter((s) => s.timestamp >= cutoff),
      wordsRef.current,
      mergesRef.current
    );

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
    modelId: "scribe_v3_live",
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
          // Only present when speaker labels are on.
          segmentIndex: (data as { segment_index?: number }).segment_index,
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

      // ElevenLabs numbers lines and speakers from 0 again in every session,
      // so each Start begins a fresh transcript to keep labels matched up.
      stopSpeakersRef.current();
      setSegments([]);
      setWordsBySegment({});
      setMerges({});

      if (ENABLE_DIARIZATION) enableDiarization();
      await scribe.connect({ token: data.token });

      if (ENABLE_DIARIZATION) {
        stopSpeakersRef.current = listenForSpeakers(scribe.getConnection(), {
          onDiarized: (segmentIndex, words) =>
            setWordsBySegment((prev) => ({ ...prev, [segmentIndex]: words })),
          onSpeakersMerged: (from, to) =>
            setMerges((prev) => ({ ...prev, [from]: to })),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start");
    }
  };

  const stop = () => {
    stopSpeakersRef.current();
    stopSpeakersRef.current = () => {};
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
            {segments.map((s) => {
              const runs = runsFor(s, wordsBySegment, merges);
              if (!runs) return <p key={s.id}>{s.text}</p>;
              return (
                <p key={s.id}>
                  {runs.map((r, i) => (
                    <span key={i}>
                      <span className={`font-semibold ${speakerColour(r.speaker)}`}>
                        {speakerLabel(r.speaker)}:
                      </span>{" "}
                      {r.text}{" "}
                    </span>
                  ))}
                </p>
              );
            })}
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
