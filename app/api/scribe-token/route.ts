import { NextResponse } from "next/server";

// Mints a short-lived, single-use token for the browser to open a Scribe
// realtime session directly with ElevenLabs. The real API key stays on
// the server and is never sent to the client.
export async function GET() {
  if (!process.env.ELEVENLABS_API_KEY) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY not set on the server" },
      { status: 500 }
    );
  }

  const response = await fetch(
    "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
      },
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json(
      { error: `ElevenLabs token request failed: ${response.status} ${detail}` },
      { status: 502 }
    );
  }

  const data = await response.json();
  return NextResponse.json({ token: data.token });
}
