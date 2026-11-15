"use client";

import {
  CommitStrategy,
  Scribe,
  useScribe,
  type RealtimeConnection,
  type TranscriptSegment,
  type WordTimestamp,
} from "@elevenlabs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Increment this version badge on every code change.
const APP_VERSION = "v0.6.0";

type GateResult = {
  id: string;
  postId?: string;
  segmentIds: string[];
  should_post: boolean;
  message: string;
  reason?: string;
  at: string;
};

type AudioMode = "noise-filter" | "diarization";

type DiarizedSegment = TranscriptSegment & {
  sessionId: number;
  mode: AudioMode;
  serverSegmentIndex?: number;
  diarizedPending?: boolean;
};

type DiarizedTranscriptMessage = {
  message_type: "diarized_transcript";
  segment_index?: number;
  text: string;
  words?: WordTimestamp[];
};

type SpeakersMergedMessage = {
  message_type: "speakers_merged";
  from_speaker_id: string;
  to_speaker_id: string;
};

type RawDiarizationEvent = DiarizedTranscriptMessage | SpeakersMergedMessage;

interface ScribeStaticRuntime {
  buildWebSocketUri?: (options: {
    modelId: string;
    filterBackgroundAudio?: boolean;
    [key: string]: unknown;
  }) => string;
  connect?: (options: Record<string, unknown>) => RealtimeConnection;
  __cipherOrigBuildUri?: (options: {
    modelId: string;
    filterBackgroundAudio?: boolean;
    [key: string]: unknown;
  }) => string;
  __cipherOrigConnect?: (options: Record<string, unknown>) => RealtimeConnection;
  __cipherListeners?: WeakMap<
    RealtimeConnection,
    (event: RawDiarizationEvent) => void
  >;
  __cipherPendingConnectHandler?: ((event: RawDiarizationEvent) => void) | null;
}

function getScribeRuntime(): ScribeStaticRuntime {
  const ScribeInternal = Scribe as unknown as ScribeStaticRuntime;
  if (!ScribeInternal.__cipherListeners) {
    ScribeInternal.__cipherListeners = new WeakMap();
  }
  return ScribeInternal;
}

function ensureScribeDiarizationSupport(
  pendingConnectHandler?: ((event: RawDiarizationEvent) => void) | null
) {
  const ScribeInternal = getScribeRuntime();
  if (pendingConnectHandler !== undefined) {
    ScribeInternal.__cipherPendingConnectHandler = pendingConnectHandler;
  }

  if (
    typeof ScribeInternal.buildWebSocketUri === "function" &&
    !ScribeInternal.__cipherOrigBuildUri
  ) {
    ScribeInternal.__cipherOrigBuildUri =
      ScribeInternal.buildWebSocketUri.bind(ScribeInternal);
  }

  if (ScribeInternal.__cipherOrigBuildUri) {
    const origBuildUri = ScribeInternal.__cipherOrigBuildUri;
    ScribeInternal.buildWebSocketUri = (options) => {
      const uri = origBuildUri(options);
      // Enable real-time speaker diarization on scribe_v3_live whenever
      // filterBackgroundAudio is not active (ElevenLabs forbids combining the two).
      if (
        options.modelId === "scribe_v3_live" &&
        !options.filterBackgroundAudio
      ) {
        try {
          const url = new URL(uri);
          url.searchParams.set("diarize", "true");
          return url.toString();
        } catch {
          return `${uri}${uri.includes("?") ? "&" : "?"}diarize=true`;
        }
      }
      return uri;
    };
  }

  if (
    typeof ScribeInternal.connect === "function" &&
    !ScribeInternal.__cipherOrigConnect
  ) {
    ScribeInternal.__cipherOrigConnect =
      ScribeInternal.connect.bind(ScribeInternal);
  }

  if (ScribeInternal.__cipherOrigConnect) {
    const origConnect = ScribeInternal.__cipherOrigConnect;
    ScribeInternal.connect = (options) => {
      const connection = origConnect(options);
      const runtime = getScribeRuntime();
      const listeners = runtime.__cipherListeners!;
      if (runtime.__cipherPendingConnectHandler) {
        listeners.set(connection, runtime.__cipherPendingConnectHandler);
        runtime.__cipherPendingConnectHandler = null;
      }

      const ws = (
        connection as unknown as {
          websocket?: WebSocket & { __cipherHooked?: boolean };
        }
      ).websocket;
      if (ws && !ws.__cipherHooked) {
        ws.__cipherHooked = true;
        ws.addEventListener("message", (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          try {
            const parsed = JSON.parse(event.data) as { message_type?: string };
            if (
              parsed.message_type === "diarized_transcript" ||
              parsed.message_type === "speakers_merged"
            ) {
              // Strictly require this connection to still be registered in WeakMap
              // so a stopped/closed socket can never leak events into a newer session.
              const listener = getScribeRuntime().__cipherListeners?.get(
                connection
              );
              listener?.(parsed as RawDiarizationEvent);
            }
          } catch {
            // Ignore non-JSON frames
          }
        });
        ws.addEventListener("close", () => {
          getScribeRuntime().__cipherListeners?.delete(connection);
        });
      }
      return connection;
    };
  }
}

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
// Scribe v3 Live uses server-side VAD (CommitStrategy.VAD) to commit on
// conversational turns. If someone speaks non-stop for this long without a
// server commit, force one as a safety fallback so Cipher still sees it.
const FORCE_COMMIT_MS = 10000;
// Max time to wait for a delayed diarized_transcript before marking a segment resolved.
const DIARIZED_PENDING_TIMEOUT_MS = 5000;
// Max entries to keep in pendingDiarizedByKeyRef / pendingTimestampsByKeyRef.
const MAX_PENDING_DIARIZED = 30;
const WAKE_WORD_PATTERN = /\b[cs][iy](?:ph|f)er\b/i;

const SPEAKER_STYLES = [
  {
    badge: "bg-emerald-950/90 border-emerald-700/70 text-emerald-300",
    border: "border-l-emerald-500/70",
    dot: "bg-emerald-400",
  },
  {
    badge: "bg-sky-950/90 border-sky-700/70 text-sky-300",
    border: "border-l-sky-500/70",
    dot: "bg-sky-400",
  },
  {
    badge: "bg-amber-950/90 border-amber-700/70 text-amber-300",
    border: "border-l-amber-500/70",
    dot: "bg-amber-400",
  },
  {
    badge: "bg-violet-950/90 border-violet-700/70 text-violet-300",
    border: "border-l-violet-500/70",
    dot: "bg-violet-400",
  },
  {
    badge: "bg-rose-950/90 border-rose-700/70 text-rose-300",
    border: "border-l-rose-500/70",
    dot: "bg-rose-400",
  },
  {
    badge: "bg-fuchsia-950/90 border-fuchsia-700/70 text-fuchsia-300",
    border: "border-l-fuchsia-500/70",
    dot: "bg-fuchsia-400",
  },
  {
    badge: "bg-lime-950/90 border-lime-700/70 text-lime-300",
    border: "border-l-lime-500/70",
    dot: "bg-lime-400",
  },
  {
    badge: "bg-orange-950/90 border-orange-700/70 text-orange-300",
    border: "border-l-orange-500/70",
    dot: "bg-orange-400",
  },
];

function getSpeakerStyle(rawId: string | null, sessionId = 1) {
  if (!rawId) {
    return {
      badge: "bg-neutral-900 border-neutral-700 text-neutral-400",
      border: "border-l-neutral-700",
      dot: "bg-neutral-500",
    };
  }
  if (rawId === "you") {
    return {
      badge: "bg-cyan-950/90 border-cyan-700/70 text-cyan-300",
      border: "border-l-cyan-500/70",
      dot: "bg-cyan-400",
    };
  }
  const sessionOffset = Math.max(0, sessionId - 1) * 3;
  const match = rawId.match(/^(?:speaker_)?(\d+)$/i);
  if (match) {
    const idx = (Number(match[1]) + sessionOffset) % SPEAKER_STYLES.length;
    return SPEAKER_STYLES[idx];
  }
  let hash = sessionOffset;
  for (let i = 0; i < rawId.length; i++) {
    hash = (hash * 31 + rawId.charCodeAt(i)) >>> 0;
  }
  return SPEAKER_STYLES[hash % SPEAKER_STYLES.length];
}

function formatSpeakerLabel(
  rawId: string,
  sessionId?: number,
  activeSessionId?: number
): string {
  if (rawId === "you") {
    return "You (typed)";
  }
  const sessionPrefix =
    sessionId !== undefined &&
    activeSessionId !== undefined &&
    sessionId !== activeSessionId
      ? `S${sessionId} · `
      : "";
  const match = rawId.match(/^(?:speaker_)?(\d+)$/i);
  if (match) {
    return `${sessionPrefix}Speaker ${Number(match[1]) + 1} (${rawId})`;
  }
  return `${sessionPrefix}Speaker ${rawId}`;
}

function normalizeForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function resolveCanonicalSpeakerId(
  rawId: string | null | undefined,
  mergeMap: Map<string, string>
): string | undefined {
  if (typeof rawId !== "string" || rawId.length === 0) return undefined;
  let current = rawId;
  const visited = new Set<string>();
  while (mergeMap.has(current) && !visited.has(current)) {
    visited.add(current);
    current = mergeMap.get(current)!;
  }
  return current;
}

// Aligns incoming words with previous/provisional words when incoming words have
// unresolved (null) speaker_id values, without forward-filling across speaker boundaries.
function mergeWordsWithSpeakerFallback(
  incoming: WordTimestamp[] | undefined,
  previous: WordTimestamp[] | undefined,
  mergeMap: Map<string, string>
): WordTimestamp[] | undefined {
  if (!incoming || incoming.length === 0) {
    if (!previous || previous.length === 0) return undefined;
    return previous.map((w) => {
      const resolved = resolveCanonicalSpeakerId(w.speaker_id, mergeMap);
      return resolved ? { ...w, speaker_id: resolved } : w;
    });
  }

  return incoming.map((w, idx) => {
    const directSpeaker = resolveCanonicalSpeakerId(w.speaker_id, mergeMap);
    if (directSpeaker) {
      return { ...w, speaker_id: directSpeaker };
    }

    const tokenTrimmed = w.text?.trim();
    if (!tokenTrimmed || !previous || previous.length === 0) {
      return w;
    }

    // 1. Prefer matching by overlapping word timestamps when available
    if (typeof w.start === "number" && typeof w.end === "number") {
      const mid = (w.start + w.end) / 2;
      const timeMatch = previous.find(
        (pw) =>
          typeof pw.start === "number" &&
          typeof pw.end === "number" &&
          mid >= pw.start - 0.15 &&
          mid <= pw.end + 0.15 &&
          pw.text?.trim().toLowerCase() === tokenTrimmed.toLowerCase()
      );
      const timeSpeaker = resolveCanonicalSpeakerId(
        timeMatch?.speaker_id,
        mergeMap
      );
      if (timeSpeaker) {
        return { ...w, speaker_id: timeSpeaker };
      }
    }

    // 2. Fallback to exact index + word text match (common across consecutive partial frames)
    const prevAtIdx = previous[idx];
    if (
      prevAtIdx &&
      prevAtIdx.text?.trim().toLowerCase() === tokenTrimmed.toLowerCase()
    ) {
      const idxSpeaker = resolveCanonicalSpeakerId(
        prevAtIdx.speaker_id,
        mergeMap
      );
      if (idxSpeaker) {
        return { ...w, speaker_id: idxSpeaker };
      }
    }

    return w;
  });
}

type SpeakerRun = {
  rawSpeakerId: string | null;
  speaker: string | null;
  text: string;
};

function getWordsSpeakerRuns(
  words: WordTimestamp[] | undefined,
  fallbackText: string,
  opts?: {
    preferFallbackTextForSingleRun?: boolean;
    sessionId?: number;
    activeSessionId?: number;
  }
): SpeakerRun[] {
  if (!words || words.length === 0) {
    return [{ rawSpeakerId: null, speaker: null, text: fallbackText }];
  }

  const hasSpeakerIds = words.some(
    (w: WordTimestamp) => typeof w.speaker_id === "string" && w.speaker_id.length > 0
  );
  if (!hasSpeakerIds) {
    return [{ rawSpeakerId: null, speaker: null, text: fallbackText }];
  }

  const runs: SpeakerRun[] = [];
  let currentRawId: string | null | undefined = undefined;
  let currentText = "";

  for (const w of words) {
    const token = w.text ?? "";
    const isWhitespace = token.trim().length === 0 || w.type === "spacing";

    const appendToken = (base: string, nextToken: string) => {
      if (!base) return nextToken;
      const needsSpace =
        !/\s$/.test(base) && !/^\s/.test(nextToken) && !isWhitespace;
      return `${base}${needsSpace ? " " : ""}${nextToken}`;
    };

    if (isWhitespace) {
      // Keep whitespace attached to the current run
      currentText = appendToken(currentText, token);
      continue;
    }

    // Non-whitespace word: do NOT inherit the previous speaker when speaker_id is null/missing.
    const wordSpeakerId =
      typeof w.speaker_id === "string" && w.speaker_id.length > 0
        ? w.speaker_id
        : null;

    if (currentRawId === undefined) {
      currentRawId = wordSpeakerId;
      currentText = appendToken(currentText, token);
    } else if (wordSpeakerId !== currentRawId && currentText.trim()) {
      runs.push({
        rawSpeakerId: currentRawId,
        speaker: currentRawId
          ? formatSpeakerLabel(
              currentRawId,
              opts?.sessionId,
              opts?.activeSessionId
            )
          : null,
        text: currentText.trim(),
      });
      currentRawId = wordSpeakerId;
      currentText = token;
    } else {
      currentRawId = wordSpeakerId;
      currentText = appendToken(currentText, token);
    }
  }

  if (currentText.trim()) {
    const finalRawId = currentRawId ?? null;
    runs.push({
      rawSpeakerId: finalRawId,
      speaker: finalRawId
        ? formatSpeakerLabel(
            finalRawId,
            opts?.sessionId,
            opts?.activeSessionId
          )
        : null,
      text: currentText.trim(),
    });
  }

  if (runs.length === 0) {
    return [{ rawSpeakerId: null, speaker: null, text: fallbackText }];
  }

  // When a committed segment only has 1 speaker run, preserve the authoritative committed fallbackText.
  if (
    runs.length === 1 &&
    fallbackText.trim() &&
    (opts?.preferFallbackTextForSingleRun ||
      normalizeForMatch(runs[0].text) !== normalizeForMatch(fallbackText))
  ) {
    return [
      {
        rawSpeakerId: runs[0].rawSpeakerId,
        speaker: runs[0].speaker,
        text: fallbackText,
      },
    ];
  }

  return runs;
}

function getSegmentSpeakerRuns(
  segment: DiarizedSegment,
  activeSessionId?: number
): SpeakerRun[] {
  return getWordsSpeakerRuns(segment.words, segment.text, {
    preferFallbackTextForSingleRun: true,
    sessionId: segment.sessionId,
    activeSessionId,
  });
}

function formatSegmentForGate(
  segment: DiarizedSegment,
  activeSessionId?: number
): string {
  const runs = getSegmentSpeakerRuns(segment, activeSessionId);
  if (runs.length === 1 && !runs[0].speaker) {
    return `[${segment.id}] ${segment.text}`;
  }
  return runs
    .map((r) =>
      r.speaker
        ? `[${segment.id} · ${r.speaker}]: ${r.text}`
        : `[${segment.id}] ${r.text}`
    )
    .join("\n");
}

function makeSessionIndexKey(sessionId: number, segmentIndex: number): string {
  return `${sessionId}:${segmentIndex}`;
}

export default function Home() {
  const [segments, setSegments] = useState<DiarizedSegment[]>([]);
  const [partialWords, setPartialWords] = useState<WordTimestamp[]>([]);
  const [posts, setPosts] = useState<GateResult[]>([]);
  const [log, setLog] = useState<GateResult[]>([]);
  const [gateBusy, setGateBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioMode, setAudioMode] = useState<AudioMode>("diarization");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<number>(1);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startingRef = useRef<boolean>(false);
  const lastCallAtRef = useRef<number>(0);
  // Tracks when the current continuous partial speech started (null when idle).
  const partialStartedAtRef = useRef<number | null>(null);
  const sessionIdRef = useRef<number>(1);
  const segmentsRef = useRef<DiarizedSegment[]>([]);
  const lastPartialWordsRef = useRef<WordTimestamp[]>([]);
  const speakerMergeMapRef = useRef<Map<string, string>>(new Map());
  const pendingDiarizedByKeyRef = useRef<Map<string, WordTimestamp[]>>(
    new Map()
  );
  const pendingTimestampsByKeyRef = useRef<
    Map<string, { languageCode?: string; words?: WordTimestamp[] }>
  >(new Map());
  const diarizedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const deferredGateOptsRef = useRef<{
    directAddress?: boolean;
    bypassCooldown?: boolean;
  } | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);
  const audioModeRef = useRef<AudioMode>(audioMode);
  const postsRef = useRef<GateResult[]>([]);
  const voiceEnabledRef = useRef<boolean>(true);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrlRef = useRef<string | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsGenRef = useRef<number>(0);
  const mutedByTtsRef = useRef<boolean>(false);
  const gateInFlightRef = useRef<boolean>(false);
  const pendingGateRef = useRef<{
    directAddress?: boolean;
    bypassCooldown?: boolean;
  } | null>(null);
  const nextSegNumRef = useRef<number>(1);
  const nextGateNumRef = useRef<number>(1);
  const nextPostNumRef = useRef<number>(1);

  // Unified synchronous updater for segmentsRef and React state so functional
  // and direct updates can never overwrite one another.
  const updateSegments = useCallback(
    (updater: (prev: DiarizedSegment[]) => DiarizedSegment[]) => {
      const next = updater(segmentsRef.current);
      if (next !== segmentsRef.current) {
        segmentsRef.current = next;
        setSegments(next);
      }
    },
    []
  );

  const clearDiarizedTimer = useCallback((segId: string) => {
    const timer = diarizedTimersRef.current.get(segId);
    if (timer) {
      clearTimeout(timer);
      diarizedTimersRef.current.delete(segId);
    }
  }, []);

  const clearAllDiarizedPending = useCallback(() => {
    for (const timer of diarizedTimersRef.current.values()) {
      clearTimeout(timer);
    }
    diarizedTimersRef.current.clear();
    pendingDiarizedByKeyRef.current.clear();
    pendingTimestampsByKeyRef.current.clear();
    deferredGateOptsRef.current = null;
    updateSegments((prev) => {
      if (!prev.some((s) => s.diarizedPending)) return prev;
      return prev.map((s) =>
        s.diarizedPending ? { ...s, diarizedPending: false } : s
      );
    });
  }, [updateSegments]);

  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  useEffect(() => {
    audioModeRef.current = audioMode;
  }, [audioMode]);

  // Auto-scroll transcript container when new segments or partials arrive, unless user scrolled up
  const handleTranscriptScroll = useCallback(() => {
    const el = transcriptContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 48;
  }, []);

  useEffect(() => {
    const el = transcriptContainerRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [segments, partialWords]);

  const stopSpeaking = useCallback(() => {
    ttsGenRef.current++;
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    if (activeAudioRef.current) {
      activeAudioRef.current.onended = null;
      activeAudioRef.current.onerror = null;
      activeAudioRef.current.pause();
      activeAudioRef.current = null;
    }
    if (activeAudioUrlRef.current) {
      URL.revokeObjectURL(activeAudioUrlRef.current);
      activeAudioUrlRef.current = null;
    }
    if (mutedByTtsRef.current) {
      mutedByTtsRef.current = false;
      if (isConnectedRef.current) {
        try {
          unmuteRef.current();
        } catch {
          // Ignore if connection closed or track unavailable
        }
      }
    }
    setSpeakingId(null);
  }, []);

  const speakText = useCallback(
    async (
      text: string,
      itemId?: string,
      opts?: { requireVoiceEnabled?: boolean }
    ) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const requireVoiceEnabled = opts?.requireVoiceEnabled ?? false;
      if (requireVoiceEnabled && !voiceEnabledRef.current) return;

      // Cancel any in-flight or currently playing TTS first
      stopSpeaking();

      const gen = ++ttsGenRef.current;
      const controller = new AbortController();
      ttsAbortRef.current = controller;

      const targetId = itemId ?? "manual";
      setSpeakingId(targetId);

      // Temporarily mute the live mic while Cipher speaks so it doesn't transcribe itself.
      if (isConnectedRef.current) {
        try {
          muteRef.current();
          mutedByTtsRef.current = true;
        } catch {
          // Ignore if manual mode or track not ready
        }
      }

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `TTS failed (${res.status})`);
        }
        const blob = await res.blob();
        if (
          ttsGenRef.current !== gen ||
          (requireVoiceEnabled && !voiceEnabledRef.current)
        ) {
          return;
        }

        const url = URL.createObjectURL(blob);
        activeAudioUrlRef.current = url;

        const audio = new Audio(url);
        activeAudioRef.current = audio;
        const finishCurrent = () => {
          if (ttsGenRef.current === gen) {
            stopSpeaking();
          }
        };
        audio.onended = finishCurrent;
        audio.onerror = finishCurrent;
        await audio.play();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        if (ttsGenRef.current === gen) {
          stopSpeaking();
        }
        setError(err instanceof Error ? err.message : "TTS playback failed");
      }
    },
    [stopSpeaking]
  );

  const runGate = useCallback(
    async (opts?: { directAddress?: boolean; bypassCooldown?: boolean }) => {
      const directAddress = opts?.directAddress ?? false;
      const bypassCooldown = opts?.bypassCooldown ?? directAddress;

      if (gateInFlightRef.current) {
        // Queue at most one follow-up check if a request is already in flight,
        // preserving directAddress / bypassCooldown if either call requested it.
        pendingGateRef.current = {
          directAddress:
            Boolean(pendingGateRef.current?.directAddress) || directAddress,
          bypassCooldown:
            Boolean(pendingGateRef.current?.bypassCooldown) || bypassCooldown,
        };
        return;
      }

      const now = Date.now();
      const cutoff = now / 1000 - WINDOW_SECONDS;
      const recentSegments = segmentsRef.current.filter(
        (s) => s.timestamp >= cutoff
      );

      // If any segment in the window is still awaiting diarized_transcript,
      // defer gate evaluation until its diarized_transcript arrives or its
      // 5s timeout fires.
      if (recentSegments.some((s) => s.diarizedPending)) {
        deferredGateOptsRef.current = {
          directAddress:
            Boolean(deferredGateOptsRef.current?.directAddress) ||
            directAddress,
          bypassCooldown:
            Boolean(deferredGateOptsRef.current?.bypassCooldown) ||
            bypassCooldown,
        };
        return;
      }

      deferredGateOptsRef.current = null;

      // A direct "hey <wake word>" or manual send skips the cooldown.
      if (
        !bypassCooldown &&
        now - lastCallAtRef.current < MIN_GAP_BETWEEN_CALLS_MS
      ) {
        return;
      }
      lastCallAtRef.current = now;

      const segmentIds = recentSegments.map((s) => s.id);
      const hasDiarization = recentSegments.some((s) =>
        s.words?.some(
          (w) => typeof w.speaker_id === "string" && w.speaker_id.length > 0
        )
      );
      const currentSession = sessionIdRef.current;
      const windowText = recentSegments
        .map((s) =>
          hasDiarization ? formatSegmentForGate(s, currentSession) : s.text
        )
        .join(hasDiarization ? "\n" : " ")
        .trim();

      if (!windowText) return;

      gateInFlightRef.current = true;
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

        const gateId = `gate-${nextGateNumRef.current++}`;
        const cleanMessage =
          typeof data.message === "string" ? data.message.trim() : "";
        const shouldPost = data.should_post === true && cleanMessage.length > 0;
        const postId = shouldPost
          ? `evt-${nextPostNumRef.current++}`
          : undefined;

        const result: GateResult = {
          id: gateId,
          postId,
          segmentIds,
          should_post: shouldPost,
          message: shouldPost ? cleanMessage : "",
          reason: typeof data.reason === "string" ? data.reason : undefined,
          at: new Date().toLocaleTimeString(),
        };
        setLog((prev) => [...prev, result]);
        if (shouldPost) {
          const nextPosts = [...postsRef.current, result];
          postsRef.current = nextPosts;
          setPosts(nextPosts);
          if (voiceEnabledRef.current) {
            void speakText(result.message, postId ?? gateId, {
              requireVoiceEnabled: true,
            });
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "gate request failed");
      } finally {
        gateInFlightRef.current = false;
        setGateBusy(false);
        const nextPending = pendingGateRef.current;
        if (nextPending) {
          pendingGateRef.current = null;
          void runGate(nextPending);
        }
      }
    },
    [speakText]
  );

  // Triggered whenever a segment's diarizedPending flag clears (either via
  // diarized_transcript or via the 5s timeout) so any deferred gate check runs.
  const flushDeferredGateIfReady = useCallback(() => {
    const deferred = deferredGateOptsRef.current;
    if (!deferred) return;
    const cutoff = Date.now() / 1000 - WINDOW_SECONDS;
    const stillPending = segmentsRef.current.some(
      (s) => s.timestamp >= cutoff && s.diarizedPending
    );
    if (!stillPending) {
      deferredGateOptsRef.current = null;
      void runGate(deferred);
    }
  }, [runGate]);

  const handleDiarizationSocketEventForSession = useCallback(
    (boundSessionId: number, event: RawDiarizationEvent) => {
      // Ignore events from any stale/closed session socket
      if (boundSessionId !== sessionIdRef.current) {
        return;
      }

      if (event.message_type === "diarized_transcript") {
        const trimmed = event.text?.trim();
        if (!trimmed && (!event.words || event.words.length === 0)) {
          return;
        }

        const prev = segmentsRef.current;
        let targetIdx = -1;
        const hasSegmentIndex = typeof event.segment_index === "number";

        if (hasSegmentIndex) {
          // Strict correlation by segment_index when provided by Scribe v3 Live.
          targetIdx = prev.findIndex(
            (s) =>
              s.sessionId === boundSessionId &&
              s.serverSegmentIndex === event.segment_index
          );
          if (targetIdx === -1) {
            // Buffer until the matching committed_transcript arrives; do NOT
            // fall back to text/FIFO when segment_index is present.
            if (event.words) {
              const key = makeSessionIndexKey(
                boundSessionId,
                event.segment_index!
              );
              if (pendingDiarizedByKeyRef.current.size >= MAX_PENDING_DIARIZED) {
                const oldestKey = pendingDiarizedByKeyRef.current
                  .keys()
                  .next().value;
                if (oldestKey !== undefined) {
                  pendingDiarizedByKeyRef.current.delete(oldestKey);
                }
              }
              pendingDiarizedByKeyRef.current.set(key, event.words);
            }
            return;
          }
        } else {
          // Only use text or FIFO fallback when segment_index is absent
          if (trimmed) {
            const normEventText = normalizeForMatch(trimmed);
            for (let i = prev.length - 1; i >= 0; i--) {
              if (
                prev[i].sessionId === boundSessionId &&
                prev[i].diarizedPending &&
                normalizeForMatch(prev[i].text) === normEventText
              ) {
                targetIdx = i;
                break;
              }
            }
          }
          if (targetIdx === -1) {
            targetIdx = prev.findIndex(
              (s) =>
                s.sessionId === boundSessionId &&
                s.diarizedPending &&
                s.serverSegmentIndex === undefined
            );
          }
          if (targetIdx === -1) {
            return;
          }
        }

        const target = prev[targetIdx];
        clearDiarizedTimer(target.id);

        updateSegments((current) => {
          const idx = current.findIndex((s) => s.id === target.id);
          if (idx === -1) return current;
          const seg = current[idx];
          const mergedWords = mergeWordsWithSpeakerFallback(
            event.words,
            seg.words,
            speakerMergeMapRef.current
          );
          const next = [...current];
          next[idx] = {
            ...seg,
            serverSegmentIndex:
              seg.serverSegmentIndex ??
              (hasSegmentIndex ? event.segment_index : undefined),
            diarizedPending: false,
            words: mergedWords,
          };
          return next;
        });

        flushDeferredGateIfReady();
      } else if (event.message_type === "speakers_merged") {
        const { from_speaker_id: fromId, to_speaker_id: toId } = event;
        if (!fromId || !toId || fromId === toId) return;

        const map = speakerMergeMapRef.current;
        if (map.get(toId) === fromId) {
          map.delete(toId);
        }
        const canonicalTo = resolveCanonicalSpeakerId(toId, map) ?? toId;
        map.set(fromId, canonicalTo);
        for (const [k, v] of map.entries()) {
          const resolved = resolveCanonicalSpeakerId(v, map);
          if (resolved && resolved !== v) {
            map.set(k, resolved);
          }
        }

        // Retroactively update any pending diarized words for this session
        const sessionPrefix = `${boundSessionId}:`;
        for (const [key, words] of pendingDiarizedByKeyRef.current.entries()) {
          if (!key.startsWith(sessionPrefix)) continue;
          pendingDiarizedByKeyRef.current.set(
            key,
            words.map((w) => {
              const resolved = resolveCanonicalSpeakerId(w.speaker_id, map);
              return resolved && resolved !== w.speaker_id
                ? { ...w, speaker_id: resolved }
                : w;
            })
          );
        }

        // Update current partial words
        if (lastPartialWordsRef.current.length > 0) {
          const updatedPartial = lastPartialWordsRef.current.map((w) => {
            const resolved = resolveCanonicalSpeakerId(w.speaker_id, map);
            return resolved && resolved !== w.speaker_id
              ? { ...w, speaker_id: resolved }
              : w;
          });
          lastPartialWordsRef.current = updatedPartial;
          setPartialWords(updatedPartial);
        }

        // Retroactively update committed transcript segments in this session
        updateSegments((prev) => {
          let anyChanged = false;
          const next = prev.map((seg) => {
            if (
              seg.sessionId !== boundSessionId ||
              !seg.words ||
              seg.words.length === 0
            ) {
              return seg;
            }
            let segChanged = false;
            const nextWords = seg.words.map((w) => {
              const resolved = resolveCanonicalSpeakerId(w.speaker_id, map);
              if (resolved && resolved !== w.speaker_id) {
                segChanged = true;
                return { ...w, speaker_id: resolved };
              }
              return w;
            });
            if (segChanged) {
              anyChanged = true;
              return { ...seg, words: nextWords };
            }
            return seg;
          });
          return anyChanged ? next : prev;
        });
      }
    },
    [clearDiarizedTimer, flushDeferredGateIfReady, updateSegments]
  );

  // Ensure Scribe static methods are wrapped on mount
  useEffect(() => {
    ensureScribeDiarizationSupport();
  }, []);

  const scribe = useScribe({
    autoConnect: false,
    modelId: "scribe_v3_live",
    commitStrategy: CommitStrategy.VAD,
    // Always transcribe as English; auto-detect sometimes mistakes short
    // clips (e.g. "Cipher") for another language.
    languageCode: "en",
    // Bias the transcriber towards spelling the name correctly.
    keyterms: ["Cipher"],
    // Pass an explicit boolean for includeTimestamps so @elevenlabs/react does not
    // auto-enable includeTimestamps=true when onCommittedTranscriptWithTimestamps is defined.
    filterBackgroundAudio: audioMode === "noise-filter" ? true : undefined,
    includeTimestamps: audioMode === "diarization",
    microphone: { echoCancellation: true, noiseSuppression: true },
    onPartialTranscript: (data) => {
      const raw = data as { text?: string; words?: WordTimestamp[] };
      if (
        !raw.text?.trim() ||
        !Array.isArray(raw.words) ||
        raw.words.length === 0
      ) {
        lastPartialWordsRef.current = [];
        setPartialWords([]);
        return;
      }
      const merged =
        mergeWordsWithSpeakerFallback(
          raw.words,
          lastPartialWordsRef.current,
          speakerMergeMapRef.current
        ) ?? [];
      lastPartialWordsRef.current = merged;
      setPartialWords(merged);
    },
    onCommittedTranscript: (data) => {
      const raw = data as { text?: string; segment_index?: number };
      const trimmed = raw.text?.trim();
      const provisionalWords = lastPartialWordsRef.current;
      lastPartialWordsRef.current = [];
      setPartialWords([]);

      const currentSessionId = sessionIdRef.current;
      const serverSegmentIndex =
        typeof raw.segment_index === "number" ? raw.segment_index : undefined;
      const indexKey =
        serverSegmentIndex !== undefined
          ? makeSessionIndexKey(currentSessionId, serverSegmentIndex)
          : undefined;

      if (!trimmed) {
        if (indexKey) {
          pendingDiarizedByKeyRef.current.delete(indexKey);
          pendingTimestampsByKeyRef.current.delete(indexKey);
        }
        return;
      }
      partialStartedAtRef.current = null;

      const preArrivedDiarized = indexKey
        ? pendingDiarizedByKeyRef.current.get(indexKey)
        : undefined;
      if (indexKey && preArrivedDiarized) {
        pendingDiarizedByKeyRef.current.delete(indexKey);
      }

      const preArrivedTimestamps = indexKey
        ? pendingTimestampsByKeyRef.current.get(indexKey)
        : undefined;
      if (indexKey && preArrivedTimestamps) {
        pendingTimestampsByKeyRef.current.delete(indexKey);
      }

      const initialWords = mergeWordsWithSpeakerFallback(
        preArrivedDiarized ?? preArrivedTimestamps?.words ?? provisionalWords,
        provisionalWords,
        speakerMergeMapRef.current
      );

      const segId = `seg-${nextSegNumRef.current++}`;
      const currentMode = audioModeRef.current;
      const isPending = currentMode === "diarization" && !preArrivedDiarized;
      const newSeg: DiarizedSegment = {
        id: segId,
        sessionId: currentSessionId,
        mode: currentMode,
        text: trimmed,
        timestamp: Date.now() / 1000,
        isFinal: true,
        languageCode: preArrivedTimestamps?.languageCode,
        serverSegmentIndex,
        diarizedPending: isPending,
        words: initialWords,
      };
      updateSegments((prev) => [...prev, newSeg]);

      if (isPending) {
        const timer = setTimeout(() => {
          diarizedTimersRef.current.delete(segId);
          updateSegments((prev) =>
            prev.map((s) =>
              s.id === segId && s.diarizedPending
                ? { ...s, diarizedPending: false }
                : s
            )
          );
          flushDeferredGateIfReady();
        }, DIARIZED_PENDING_TIMEOUT_MS);
        diarizedTimersRef.current.set(segId, timer);
      }

      // A direct address ("hey cipher, ...") jumps the queue: short debounce,
      // and runGate is told to bypass the normal cooldown too.
      const directAddress = WAKE_WORD_PATTERN.test(trimmed);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(
        () => void runGate(directAddress ? { directAddress: true } : undefined),
        directAddress ? DIRECT_ADDRESS_DEBOUNCE_MS : SILENCE_DEBOUNCE_MS
      );
    },
    onCommittedTranscriptWithTimestamps: (data) => {
      const raw = data as {
        text?: string;
        language_code?: string;
        words?: WordTimestamp[];
        segment_index?: number;
      };
      const trimmed = raw.text?.trim();
      if (!trimmed) return;
      const currentSessionId = sessionIdRef.current;
      const hasSegmentIndex = typeof raw.segment_index === "number";

      updateSegments((prev) => {
        // Note: committed_transcript_with_timestamps sets speaker_id: null on
        // every word, whereas diarized_transcript carries the actual speaker_id.
        // Never overwrite existing speaker_id values with null.
        let targetIdx = -1;
        if (hasSegmentIndex) {
          targetIdx = prev.findIndex(
            (s) =>
              s.sessionId === currentSessionId &&
              s.serverSegmentIndex === raw.segment_index
          );
        }
        if (targetIdx === -1) {
          const normTrimmed = normalizeForMatch(trimmed);
          for (let i = prev.length - 1; i >= 0; i--) {
            if (
              prev[i].sessionId === currentSessionId &&
              normalizeForMatch(prev[i].text) === normTrimmed
            ) {
              targetIdx = i;
              break;
            }
          }
        }
        if (targetIdx === -1) {
          if (hasSegmentIndex) {
            const key = makeSessionIndexKey(
              currentSessionId,
              raw.segment_index!
            );
            if (pendingTimestampsByKeyRef.current.size >= MAX_PENDING_DIARIZED) {
              const oldestKey = pendingTimestampsByKeyRef.current
                .keys()
                .next().value;
              if (oldestKey !== undefined) {
                pendingTimestampsByKeyRef.current.delete(oldestKey);
              }
            }
            pendingTimestampsByKeyRef.current.set(key, {
              languageCode: raw.language_code,
              words: raw.words,
            });
          }
          return prev;
        }

        const existing = prev[targetIdx];
        const existingHasSpeakers = existing.words?.some(
          (w) => typeof w.speaker_id === "string" && w.speaker_id.length > 0
        );
        const next = [...prev];
        next[targetIdx] = {
          ...existing,
          languageCode: raw.language_code ?? existing.languageCode,
          words: existingHasSpeakers
            ? existing.words
            : mergeWordsWithSpeakerFallback(
                raw.words,
                existing.words,
                speakerMergeMapRef.current
              ),
        };
        return next;
      });
    },
    onDisconnect: () => {
      startingRef.current = false;
      setStarting(false);
      clearAllDiarizedPending();
    },
    onError: (e) => {
      startingRef.current = false;
      setStarting(false);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const isConnectedRef = useRef(scribe.isConnected);
  const muteRef = useRef(scribe.mute);
  const unmuteRef = useRef(scribe.unmute);
  useEffect(() => {
    isConnectedRef.current = scribe.isConnected;
    muteRef.current = scribe.mute;
    unmuteRef.current = scribe.unmute;
  }, [scribe.isConnected, scribe.mute, scribe.unmute]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
    if (!voiceEnabled) {
      stopSpeaking();
    }
  }, [voiceEnabled, stopSpeaking]);

  // If the user starts listening while Cipher is already speaking a reply,
  // mute the newly connected mic track until playback finishes.
  useEffect(() => {
    if (scribe.isConnected && speakingId && !mutedByTtsRef.current) {
      try {
        scribe.mute();
        mutedByTtsRef.current = true;
      } catch {
        // Ignore if track not ready yet
      }
    }
  }, [scribe.isConnected, speakingId, scribe]);

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manualInput.trim();
    if (!trimmed) return;
    setManualInput("");

    const segId = `seg-${nextSegNumRef.current++}`;
    const newSeg: DiarizedSegment = {
      id: segId,
      sessionId: sessionIdRef.current,
      mode: audioModeRef.current,
      text: trimmed,
      timestamp: Date.now() / 1000,
      isFinal: true,
      diarizedPending: false,
      words: [{ text: trimmed, type: "word", speaker_id: "you" }],
    };
    updateSegments((prev) => [...prev, newSeg]);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Manual message bypasses the 15s rate-limit cooldown so the user gets an immediate
    // gate evaluation, while only setting directAddress: true if it mentions Cipher.
    const directAddress = WAKE_WORD_PATTERN.test(trimmed);
    await runGate({ directAddress, bypassCooldown: true });
  };

  useEffect(() => {
    const timersMap = diarizedTimersRef.current;
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      for (const timer of timersMap.values()) {
        clearTimeout(timer);
      }
      timersMap.clear();
      getScribeRuntime().__cipherPendingConnectHandler = null;
      stopSpeaking();
    };
  }, [stopSpeaking]);

  // Keep the latest draft text and commit function in refs so the timer
  // below always sees current values. Also track when continuous partial speech
  // first became non-empty so FORCE_COMMIT_MS measures actual utterance duration.
  const partialRef = useRef("");
  const commitRef = useRef(scribe.commit);
  useEffect(() => {
    const trimmed = scribe.partialTranscript.trim();
    if (trimmed && partialStartedAtRef.current === null) {
      partialStartedAtRef.current = Date.now();
    } else if (!trimmed) {
      partialStartedAtRef.current = null;
    }
    partialRef.current = scribe.partialTranscript;
    const el = transcriptContainerRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [scribe.partialTranscript]);
  useEffect(() => {
    commitRef.current = scribe.commit;
  }, [scribe.commit]);

  useEffect(() => {
    if (!scribe.isConnected) {
      partialStartedAtRef.current = null;
      return;
    }
    const id = setInterval(() => {
      const startedAt = partialStartedAtRef.current;
      if (
        partialRef.current.trim() &&
        startedAt !== null &&
        Date.now() - startedAt >= FORCE_COMMIT_MS
      ) {
        partialStartedAtRef.current = Date.now();
        try {
          commitRef.current();
        } catch {
          // Ignore if connection closed concurrently
        }
      }
    }, 1000);
    return () => clearInterval(id);
  }, [scribe.isConnected]);

  const start = async () => {
    if (startingRef.current || scribe.isConnected || scribe.status === "connecting") {
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/scribe-token", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || data.error || typeof data.token !== "string") {
        throw new Error(data.error || "Failed to fetch Scribe token");
      }

      const nextSessionId = ++sessionIdRef.current;
      setActiveSessionId(nextSessionId);
      speakerMergeMapRef.current.clear();
      clearAllDiarizedPending();
      lastPartialWordsRef.current = [];
      setPartialWords([]);

      const sessionBoundHandler = (event: RawDiarizationEvent) =>
        handleDiarizationSocketEventForSession(nextSessionId, event);
      ensureScribeDiarizationSupport(sessionBoundHandler);

      await scribe.connect({
        token: data.token,
        filterBackgroundAudio:
          audioMode === "noise-filter" ? true : undefined,
        includeTimestamps: audioMode === "diarization",
      });
      const conn = scribe.getConnection();
      if (conn) {
        getScribeRuntime().__cipherListeners?.set(conn, sessionBoundHandler);
      }
    } catch (err) {
      getScribeRuntime().__cipherPendingConnectHandler = null;
      setError(err instanceof Error ? err.message : "failed to start");
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const stop = () => {
    startingRef.current = false;
    setStarting(false);
    getScribeRuntime().__cipherPendingConnectHandler = null;
    const conn = scribe.getConnection();
    if (conn) {
      getScribeRuntime().__cipherListeners?.delete(conn);
    }
    scribe.disconnect();
    clearAllDiarizedPending();
    lastPartialWordsRef.current = [];
    setPartialWords([]);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  };

  const live = scribe.isConnected;
  const connecting = starting || scribe.status === "connecting";

  // Summarize all speakers detected across committed and partial segments,
  // scoped by (sessionId, rawSpeakerId) so speakers from different sessions never collide.
  const detectedSpeakers = useMemo(() => {
    const entries = new Map<
      string,
      { sessionId: number; rawId: string; count: number }
    >();
    for (const seg of segments) {
      const runs = getSegmentSpeakerRuns(seg, activeSessionId);
      for (const r of runs) {
        if (r.rawSpeakerId) {
          const key = `${seg.sessionId}:${r.rawSpeakerId}`;
          const prev = entries.get(key);
          if (prev) {
            prev.count += 1;
          } else {
            entries.set(key, {
              sessionId: seg.sessionId,
              rawId: r.rawSpeakerId,
              count: 1,
            });
          }
        }
      }
    }
    if (scribe.partialTranscript && partialWords.length > 0) {
      const pRuns = getWordsSpeakerRuns(partialWords, scribe.partialTranscript, {
        sessionId: activeSessionId,
        activeSessionId,
      });
      for (const r of pRuns) {
        if (r.rawSpeakerId) {
          const key = `${activeSessionId}:${r.rawSpeakerId}`;
          if (!entries.has(key)) {
            entries.set(key, {
              sessionId: activeSessionId,
              rawId: r.rawSpeakerId,
              count: 0,
            });
          }
        }
      }
    }
    return Array.from(entries.entries()).map(([key, item]) => ({
      key,
      rawId: item.rawId,
      sessionId: item.sessionId,
      label: formatSpeakerLabel(item.rawId, item.sessionId, activeSessionId),
      count: item.count,
      style: getSpeakerStyle(item.rawId, item.sessionId),
    }));
  }, [segments, scribe.partialTranscript, partialWords, activeSessionId]);

  const partialRuns = useMemo(
    () =>
      scribe.partialTranscript
        ? getWordsSpeakerRuns(partialWords, scribe.partialTranscript, {
            sessionId: activeSessionId,
            activeSessionId,
          })
        : [],
    [partialWords, scribe.partialTranscript, activeSessionId]
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <main className="max-w-6xl mx-auto px-6 py-10 space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-4xl font-bold tracking-tight">Cipher</h1>
              <span
                className="rounded-md border border-sky-800/80 bg-sky-950/60 px-2 py-0.5 font-mono text-xs font-semibold text-sky-300"
                title="Application build version (incremented on every change)"
              >
                {APP_VERSION}
              </span>
              <span className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs font-medium text-neutral-400">
                Scribe v3 Live
              </span>
              <span className="rounded-md border border-emerald-900/60 bg-emerald-950/40 px-2 py-0.5 text-xs font-medium text-emerald-400">
                Eleven v3 TTS
              </span>
            </div>
            <p className="text-neutral-400 text-sm">
              Listening in · speaks up only when it has something worth adding
              · say &ldquo;Cipher&rdquo; to ask it directly
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => setVoiceEnabled((v) => !v)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                voiceEnabled
                  ? "border-emerald-700/80 bg-emerald-950/50 text-emerald-300 hover:bg-emerald-900/50"
                  : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200"
              }`}
              title="Toggle spoken replies via ElevenLabs Eleven v3"
            >
              {voiceEnabled ? "Voice reply: On" : "Voice reply: Off"}
            </button>

            <div
              className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-1 text-xs"
              title={
                live || connecting
                  ? "Stop listening to switch Scribe v3 session mode"
                  : "Choose between background noise filtering or speaker diarization"
              }
            >
              <button
                type="button"
                disabled={live || connecting}
                onClick={() => setAudioMode("noise-filter")}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  audioMode === "noise-filter"
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-200"
                } ${live || connecting ? "cursor-not-allowed opacity-60" : ""}`}
              >
                Noise filter
              </button>
              <button
                type="button"
                disabled={live || connecting}
                onClick={() => setAudioMode("diarization")}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  audioMode === "diarization"
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-200"
                } ${live || connecting ? "cursor-not-allowed opacity-60" : ""}`}
              >
                Speaker IDs
              </button>
            </div>

            <span className="flex items-center gap-2 text-sm font-medium">
              <span className="relative flex h-3 w-3">
                {live && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                )}
                <span
                  className={`relative inline-flex h-3 w-3 rounded-full ${
                    live
                      ? "bg-red-500"
                      : connecting
                      ? "bg-amber-500"
                      : "bg-neutral-600"
                  }`}
                />
              </span>
              {live ? "Listening" : connecting ? "Connecting…" : "Not listening"}
              {gateBusy && (
                <span className="text-neutral-400 font-normal">· thinking…</span>
              )}
              {speakingId && (
                <span className="text-emerald-400 font-normal">· speaking…</span>
              )}
            </span>
            {!live ? (
              <button
                onClick={start}
                disabled={connecting}
                className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold"
              >
                {connecting ? "Connecting…" : "Start listening"}
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          {/* Left column: Live transcript + direct input */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Live transcript ({segments.length})
              </h2>
              {audioMode === "diarization" && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {detectedSpeakers.length === 0 ? (
                    <span className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 font-mono text-[10px] text-neutral-400">
                      {live
                        ? "Diarization active (diarize=true)"
                        : "Speaker IDs mode ready"}
                    </span>
                  ) : (
                    detectedSpeakers.map((sp) => (
                      <span
                        key={sp.key}
                        className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] ${sp.style.badge}`}
                        title={`${sp.label}: ${sp.count} spoken turn(s)`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${sp.style.dot}`}
                        />
                        {sp.label}
                        {sp.count > 0 && (
                          <span className="opacity-70">
                            · {sp.count} {sp.count === 1 ? "turn" : "turns"}
                          </span>
                        )}
                      </span>
                    ))
                  )}
                </div>
              )}
            </div>

            <div
              ref={transcriptContainerRef}
              onScroll={handleTranscriptScroll}
              className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 min-h-96 max-h-[62vh] overflow-y-auto text-sm text-neutral-300 space-y-2.5"
            >
              {segments.length === 0 && !scribe.partialTranscript && (
                <p className="text-neutral-600">Waiting for speech…</p>
              )}
              {segments.map((s) => {
                const runs = getSegmentSpeakerRuns(s, activeSessionId);
                const multiTurn = runs.length > 1;
                return (
                  <div
                    key={s.id}
                    className="rounded-lg border border-neutral-800/80 bg-neutral-950/50 p-2.5 space-y-1.5"
                  >
                    {runs.map((run, idx) => {
                      const style = getSpeakerStyle(
                        run.rawSpeakerId,
                        s.sessionId
                      );
                      const fallbackLabel =
                        s.mode === "diarization" && !run.speaker
                          ? s.diarizedPending
                            ? "Detecting speaker…"
                            : "Speaker ? (unresolved)"
                          : null;
                      return (
                        <div
                          key={idx}
                          className={`leading-relaxed ${
                            multiTurn
                              ? `border-l-2 pl-2.5 py-0.5 ${style.border}`
                              : ""
                          }`}
                        >
                          <span className="mr-1.5 rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                            {multiTurn ? `${s.id}.${idx + 1}` : s.id}
                          </span>
                          {run.speaker ? (
                            <span
                              className={`mr-1.5 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${style.badge}`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${style.dot}`}
                              />
                              {run.speaker}
                            </span>
                          ) : (
                            fallbackLabel && (
                              <span className="mr-1.5 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                                {fallbackLabel}
                              </span>
                            )
                          )}
                          <span>{run.text}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {scribe.partialTranscript && (
                <div className="rounded-lg border border-dashed border-neutral-800 bg-neutral-950/30 p-2.5 space-y-1 text-neutral-400 italic">
                  {partialRuns.map((run, idx) => {
                    const style = getSpeakerStyle(
                      run.rawSpeakerId,
                      activeSessionId
                    );
                    return (
                      <p key={idx} className="leading-relaxed">
                        <span className="mr-1.5 rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-[10px] not-italic text-neutral-400">
                          live
                        </span>
                        {run.speaker ? (
                          <span
                            className={`mr-1.5 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] not-italic ${style.badge}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${style.dot}`}
                            />
                            {run.speaker}
                          </span>
                        ) : (
                          audioMode === "diarization" && (
                            <span className="mr-1.5 rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] not-italic text-neutral-500">
                              Detecting speaker…
                            </span>
                          )
                        )}
                        {run.text}
                      </p>
                    );
                  })}
                </div>
              )}
            </div>

            <form onSubmit={handleManualSubmit} className="flex gap-2">
              <input
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="Say or type something to Cipher…"
                className="flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3.5 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-emerald-600 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!manualInput.trim() || gateBusy}
                className="rounded-lg bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </section>

          {/* Right column: Triggered events & Decision log */}
          <div className="space-y-4">
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Triggered events ({posts.length})
              </h2>
              {posts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-neutral-800 p-10 min-h-96 flex items-center justify-center text-center text-neutral-500 text-lg">
                  Nothing yet — Cipher stays quiet unless it has something worth
                  adding.
                </div>
              ) : (
                <ul className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
                  {[...posts].reverse().map((p, i) => {
                    const cardId = p.postId ?? p.id;
                    const isPlaying = speakingId === cardId;
                    return (
                      <li
                        key={cardId}
                        className={`rounded-xl border p-6 ${
                          i === 0
                            ? "border-emerald-700 bg-emerald-950/40"
                            : "border-neutral-800 bg-neutral-900/60 opacity-70"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            {p.postId && (
                              <span className="rounded bg-emerald-900/60 border border-emerald-700/60 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">
                                {p.postId}
                              </span>
                            )}
                            <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">
                              {p.id}
                            </span>
                            {p.segmentIds.length > 0 && (
                              <span className="rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                                window: {p.segmentIds.join(", ")}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => void speakText(p.message, cardId)}
                            className="rounded border border-neutral-700 bg-neutral-800/80 px-2 py-0.5 text-[11px] font-medium text-neutral-300 hover:bg-neutral-700"
                          >
                            {isPlaying ? "Speaking…" : "Speak"}
                          </button>
                        </div>
                        <p
                          className={
                            i === 0
                              ? "text-xl leading-snug"
                              : "text-base leading-snug"
                          }
                        >
                          {p.message}
                        </p>
                        <p className="text-xs text-neutral-500 mt-3">
                          Cipher · {p.at}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <details className="text-sm">
              <summary className="cursor-pointer text-neutral-500">
                Decision log ({log.length})
              </summary>
              <ul className="mt-2 space-y-2">
                {[...log].reverse().map((l) => (
                  <li
                    key={l.id}
                    className="rounded-md border border-neutral-800 p-2 text-xs text-neutral-400 space-y-1"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
                        {l.id}
                      </span>
                      {l.postId && (
                        <span className="rounded bg-emerald-950 border border-emerald-800/60 px-1.5 py-0.5 font-mono text-[10px] text-emerald-400">
                          {l.postId}
                        </span>
                      )}
                      <span
                        className={
                          l.should_post
                            ? "text-emerald-400 font-medium"
                            : "text-neutral-500"
                        }
                      >
                        {l.should_post ? "posted" : "stayed quiet"}
                      </span>
                      <span>· {l.at}</span>
                      {l.segmentIds.length > 0 && (
                        <span className="font-mono text-[10px] text-neutral-500">
                          ({l.segmentIds.join(", ")})
                        </span>
                      )}
                    </div>
                    {l.reason && <p className="text-neutral-400">{l.reason}</p>}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      </main>
    </div>
  );
}
