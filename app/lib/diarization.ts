// Speaker labels ("diarization") for ElevenLabs Scribe v3 Live.
//
// ElevenLabs' JS/React SDK doesn't support diarization yet, so this file adds
// it around the SDK rather than replacing it:
//   1. enableDiarization() adds `diarize=true` to the connection address the
//      SDK builds, so ElevenLabs starts sending speaker labels.
//   2. listenForSpeakers() listens on the same live connection for the two
//      message types the SDK doesn't know about yet: `diarized_transcript`
//      and `speakers_merged`.
// The SDK keeps doing the hard parts: microphone capture, audio conversion,
// and sending audio. Once the SDK supports diarization itself, this file can
// be deleted.

import { Scribe, type RealtimeConnection } from "@elevenlabs/client";

/** One word (or space) from a diarized transcript. */
export type DiarizedWord = {
  text: string;
  speaker_id: string | null; // "speaker_0", "speaker_1", ... or null if unknown
  type?: string; // "word", "spacing", "audio_event"
};

/** A run of consecutive words said by the same speaker. */
export type SpeakerRun = { speaker: string | null; text: string };

type DiarizedTranscriptMessage = {
  message_type: "diarized_transcript";
  segment_index: number;
  text: string;
  words: DiarizedWord[] | null;
};

type SpeakersMergedMessage = {
  message_type: "speakers_merged";
  from_speaker_id: string;
  to_speaker_id: string;
};

// The SDK marks these as private in its types, but they're ordinary
// JavaScript at runtime. These casts describe just what we use.
type ScribeInternals = { buildWebSocketUri: (options: unknown) => string };
type ConnectionInternals = { websocket: WebSocket | null };

let patched = false;

/** Make every Scribe connection ask ElevenLabs for speaker labels. */
export function enableDiarization() {
  if (patched) return;
  const scribe = Scribe as unknown as ScribeInternals;
  const original = scribe.buildWebSocketUri.bind(Scribe);
  scribe.buildWebSocketUri = (options: unknown) => {
    const url = new URL(original(options));
    url.searchParams.set("diarize", "true");
    return url.toString();
  };
  patched = true;
}

/**
 * Listen for speaker labels on an open SDK connection.
 * Returns a function that stops listening.
 */
export function listenForSpeakers(
  connection: RealtimeConnection | null,
  handlers: {
    onDiarized: (segmentIndex: number, words: DiarizedWord[]) => void;
    onSpeakersMerged: (from: string, to: string) => void;
  }
): () => void {
  const ws = (connection as unknown as ConnectionInternals | null)?.websocket;
  if (!ws) return () => {};

  const onMessage = (event: MessageEvent) => {
    let data: { message_type?: string };
    try {
      data = JSON.parse(event.data);
    } catch {
      return; // not ours to worry about; the SDK reports bad messages itself
    }
    if (data.message_type === "diarized_transcript") {
      const msg = data as DiarizedTranscriptMessage;
      handlers.onDiarized(msg.segment_index, msg.words ?? []);
    } else if (data.message_type === "speakers_merged") {
      const msg = data as SpeakersMergedMessage;
      handlers.onSpeakersMerged(msg.from_speaker_id, msg.to_speaker_id);
    }
  };

  ws.addEventListener("message", onMessage);
  return () => ws.removeEventListener("message", onMessage);
}

/**
 * Follow a chain of merges to a speaker's current ID.
 * ElevenLabs may decide two IDs were the same person ("speaker_2 is really
 * speaker_0"), and merges can chain, so keep following until we stop.
 */
export function resolveSpeaker(
  speaker: string | null,
  merges: Record<string, string>
): string | null {
  let current = speaker;
  const seen = new Set<string>();
  while (current && merges[current] && !seen.has(current)) {
    seen.add(current);
    current = merges[current];
  }
  return current;
}

/** Group words into runs of the same speaker: "speaker_0: hello there". */
export function toSpeakerRuns(
  words: DiarizedWord[],
  merges: Record<string, string>
): SpeakerRun[] {
  const runs: SpeakerRun[] = [];
  for (const word of words) {
    if (word.type === "audio_event") continue; // e.g. "(laughter)"
    const speaker = resolveSpeaker(word.speaker_id, merges);
    const last = runs[runs.length - 1];
    // Spaces have no meaningful speaker; attach them to the current run.
    if (last && (last.speaker === speaker || word.type === "spacing")) {
      last.text += word.text;
    } else {
      runs.push({ speaker, text: word.text });
    }
  }
  return runs
    .map((r) => ({ ...r, text: r.text.trim() }))
    .filter((r) => r.text.length > 0);
}

/** "speaker_0" -> "Speaker 1" (people count from 1, computers from 0). */
export function speakerLabel(speaker: string | null): string {
  if (!speaker) return "Unknown speaker";
  const n = Number(speaker.replace(/\D/g, ""));
  return Number.isFinite(n) ? `Speaker ${n + 1}` : speaker;
}
