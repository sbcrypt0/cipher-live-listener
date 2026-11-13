# Cipher: a live listener for meetups

Cipher listens to a live conversation, transcribes it in real time, and decides
for itself whether anything worth adding has come up: a relevant fact, a
correction, or a "there's a tool for that". Most of the time it stays quiet.
Say its name ("Cipher, ...") and it will answer you directly.

Built as a v0.5 for the Steel City AI community.
The aim is to make sessions more useful for the people who attend.

## How it works

```
mic → ElevenLabs Scribe v2 (live speech-to-text)
    → rolling 30-second transcript window
    → "the gate": Claude decides should_post (yes/no) + message + reason
    → shown on the page, with every decision logged (including "stayed quiet")
```

Transcription and decision-making are deliberately separate steps. A
single all-in-one model (e.g. Gemini Live's "proactive audio") would also have
worked, but keeping the decision as its own readable prompt means the logic
for *when to speak* can be inspected, explained and tuned.

| Piece | Where |
| --- | --- |
| Mic capture + live transcription | `app/page.tsx` (ElevenLabs `useScribe` hook) |
| Short-lived ElevenLabs token (keeps the real key on the server) | `app/api/scribe-token/route.ts` |
| The gate: Cipher's instructions and the Claude call | `app/api/gate/route.ts` |

### When Cipher speaks
- **Unprompted:** only if it's confident it can add something useful and
  non-obvious. Never summarises, greets, or repeats what was said.
- **When addressed by name:** always answers, even if unsure. The wake word
  also matches common transcription spellings (Cypher, Sypher, Cifer, Syfer),
  and it responds after ~0.8s instead of the usual ~3s pause.
- Answers are kept to 2–3 sentences so they can be skimmed in a live room.

### Timing
- After a natural pause (~3s), the latest 30 seconds of transcript go to the gate.
- At most one unprompted check every 15s, so a busy room doesn't spam it.
- In a noisy room the transcriber never hears a pause, so any speech that
  hasn't been finalised after 6s is finalised anyway.

## Running it

```bash
npm install
cp .env.local.example .env.local
# add your keys to .env.local:
#   ELEVENLABS_API_KEY=...   (Speech to Text access)
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
- Continuous background audio meant no lines were ever finalised, so Cipher was
  never consulted. This is what the 6-second forced finalise fixes.
- A laptop mic only reliably picks up speakers close to it.

## Known limitations / next steps
- **Room audio:** a laptop mic isn't enough for a whole table. A USB
  conference speakerphone is the likely fix.
- **Background noise filter:** ElevenLabs offers one, but the React hook used
  here doesn't expose it yet.
- **Output:** posts to this page only. Discord integration comes later.
- **Memory:** Cipher only sees the last ~30 seconds of conversation.
- Text only, no spoken replies.

Ideas and feedback from the community are very welcome.
