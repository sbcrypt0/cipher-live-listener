import { NextResponse } from "next/server";

// Mints a short-lived, single-use token for the browser to open a Scribe
// realtime session directly with ElevenLabs. The real API key stays on
// the server and is never sent to the client.
export async function GET() {
  if (!process.env.ELEVENLABS_API_KEY) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY not set on the server" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const response = await fetch(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        {
          error: `ElevenLabs token request failed (${response.status})`,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await response.json();
    if (!data || typeof data.token !== "string" || !data.token.trim()) {
      return NextResponse.json(
        { error: "Invalid token response from ElevenLabs" },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { token: data.token },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("scribe-token error", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "ElevenLabs token request failed",
      },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
