import { NextRequest, NextResponse } from "next/server";

// Default voice: "Roger - Laid-Back, Casual, Resonant" (standard ElevenLabs voice).
// Can be overridden via ELEVENLABS_VOICE_ID in .env.local or voiceId in the request body.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "CwhRBWXzGAHq8TQ4Fs17";
const DEFAULT_MODEL_ID = "eleven_v3";
const MAX_TTS_CHARS = 1000;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return NextResponse.json(
        { error: "ELEVENLABS_API_KEY not set on the server" },
        { status: 500 }
      );
    }

    const { text } = await req.json();

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { error: "text (non-empty string) is required" },
        { status: 400 }
      );
    }

    const trimmedText = text.trim().slice(0, MAX_TTS_CHARS);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
        DEFAULT_VOICE_ID
      )}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: trimmedText,
          model_id: DEFAULT_MODEL_ID,
        }),
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      return NextResponse.json(
        {
          error: `ElevenLabs TTS request failed: ${response.status} ${detail}`,
        },
        { status: 502 }
      );
    }

    const audioBuffer = await response.arrayBuffer();
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("tts error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
