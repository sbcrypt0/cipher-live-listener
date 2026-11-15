# Cipher: a live listener for meetups

Cipher listens to a live conversation, transcribes it in real time, and decides
for itself whether anything worth adding has come up: a relevant fact, a
correction, or a "there's a tool for that". Most of the time it stays quiet.
Say its name ("Cipher, ...") and it will answer you directly.

Built as a v0.5 for the Steel City AI community.
The aim is to make sessions more useful for the people who attend.

## How it works

```
mic → ElevenLabs Scribe v3 Live (realtime speech-to-text + VAD)
    → rolling 30-second transcript window (with background noise filter or speaker IDs)
    → "the gate": Claude decides should_post (yes/no) + message + reason
    → shown on the page, with every decision logged (including "stayed quiet")
```

Transcription and decision-making are deliberately separate steps. A
single all-in-one model (e.g. Gemini Live's "proactive audio") would also have
worked, but keeping the decision as its own readable prompt means the logic
for *when to speak* can be inspected, explained and tuned.

| Piece | Where |
| --- | --- |
| Mic capture + live transcription (`scribe_v3_live`) | `app/page.tsx` (ElevenLabs `useScribe` hook) |
| Short-lived ElevenLabs token (keeps the real key on the server) | `app/api/scribe-token/route.ts` |
| The gate: Cipher's instructions and the Claude call | `app/api/gate/route.ts` |
| Spoken replies via Eleven v3 (`eleven_v3`) | `app/api/tts/route.ts` |

### When Cipher speaks
- **Unprompted:** only if it's confident it can add something useful and
  non-obvious. Never summarises, greets, or repeats what was said.
- **When addressed by name:** always answers, even if unsure. The wake word
  also matches common transcription spellings (Cypher, Sypher, Cifer, Syfer),
  and it responds after ~0.8s instead of the usual ~3s pause.
- Answers are kept to 2–3 sentences so they can be skimmed in a live room, and spoken aloud via ElevenLabs `eleven_v3` when **Voice reply** is enabled.

### Timing & Audio Modes
- Uses Scribe v3 Live's server-side Voice Activity Detection (`CommitStrategy.VAD`) to commit segments on natural conversational pauses.
- After a committed segment settles (~3s), the latest 30 seconds of transcript go to the gate.
- At most one unprompted check every 15s, so a busy room doesn't spam it.
- If continuous speech builds up for 10s without a VAD commit, it is finalised automatically as a safety fallback.
- A header toggle switches between **Noise filter** (`filterBackgroundAudio: true`) and **Speaker IDs** (`includeTimestamps: true` for live speaker diarization).
- While Cipher is speaking a reply out loud, the microphone track is temporarily muted so it doesn't transcribe its own voice.

## Running it

```bash
npm install
cp .env.local.example .env.local
# add your keys to .env.local:
#   ELEVENLABS_API_KEY=...   (Speech to Text + Text to Speech access)
#   ANTHROPIC_API_KEY=...
npm run dev
```

Open http://localhost:3000, click **Start listening** and allow mic access.

## What testing has shown so far
- Ignored an unrelated TV argument playing in the background.
- Gave accurate, specific answers to tool questions (API testing, free hosting).
- When several points came up at once, it answered only one.
- Narrating a test out loud ("now I'm testing corrections...") made it treat the
  whole window as demo chatter and miss real errors next to it.
- Auto language detection once transcribed "Cipher" as Russian, so the
  language is now fixed to English.
- Continuous background audio meant no lines were ever finalised in manual mode;
  `CommitStrategy.VAD` + a 10-second forced finalise fallback handles this.
- A laptop mic only reliably picks up speakers close to it.

## Known limitations / next steps
- **Room audio:** a laptop mic isn't enough for a whole table. A USB
  conference speakerphone is the likely fix.
- **Noise filter vs. Speaker IDs:** ElevenLabs does not allow combining
  `filterBackgroundAudio` and `includeTimestamps` in the same session, so they
  are exposed as a toggle before starting a session.
- **Output:** posts to this page (with spoken Eleven v3 TTS replies). Discord integration comes later.
- **Memory:** Cipher only sees the last ~30 seconds of conversation.

Ideas and feedback from the community are very welcome.
