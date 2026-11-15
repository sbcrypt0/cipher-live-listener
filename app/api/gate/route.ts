import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

// The "gate": given a rolling window of live transcript, decide whether
// there's something worth surfacing right now, and if so, what to say.
// This is deliberately a separate, inspectable step from transcription —
// the whole point of the project is that this decision is legible and
// tunable, not a black box.

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const AGENT_NAME = "Cipher";

const SYSTEM_PROMPT = `Your name is ${AGENT_NAME}. You are a quiet, occasionally-useful \
participant listening in on a live group conversation at a tech meetup. \
You see a rolling window of the last things said (a live transcript, may \
contain STT errors and half-sentences).

Almost all the time you should say NOTHING. Only speak up when you have \
something a thoughtful, well-informed person in the room would actually \
add out loud — a relevant fact, a correction, a "there's a tool for that", \
a link-worthy reference, a connection to something said earlier. Do not \
summarize, do not restate what was said, do not greet, do not comment on \
the meta fact that people are talking.

Bar for speaking: if you're not confident it's genuinely useful and \
non-obvious, stay silent. Never post two turns in a row unless the window \
contains clearly new material since your last post.

Speakers: lines may start with "Speaker 1:", "Speaker 2:" and so on. These \
labels come from automatic speaker detection: they tell you when different \
people are talking, but they can be wrong or missing, and they are not \
names. Use them to follow the conversation, e.g. to notice when one person \
has already answered another's question (so it's no longer open), or when \
two people disagree on a fact you can settle. In your message, don't refer \
to people by speaker number and never guess anyone's name.

EXCEPTION — direct address: if the window is marked [DIRECT ADDRESS], \
someone in the room said your name on purpose to ask you something or to \
settle a question. In that case you MUST respond (should_post: true) with \
your best direct answer to whatever they asked, even if you're not fully \
certain — say so briefly in the message rather than staying silent. Being \
asked by name always overrides the normal bar for staying quiet.

Keep every message short and easy to skim in a live room: 2-3 sentences, \
roughly 50 words at most. Lead with the direct answer; skip background detail \
unless it's essential.

Respond ONLY with JSON, no other text:
{"should_post": boolean, "message": string, "reason": string}

"reason" is a short internal note on why you did or didn't post (not shown \
to the room). "message" is empty string when should_post is false.`;

export async function POST(req: NextRequest) {
  try {
    const { transcriptWindow, recentPosts, directAddress } = await req.json();

    if (!transcriptWindow || typeof transcriptWindow !== "string") {
      return NextResponse.json(
        { error: "transcriptWindow (string) is required" },
        { status: 400 }
      );
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY not set on the server" },
        { status: 500 }
      );
    }

    const priorContext =
      Array.isArray(recentPosts) && recentPosts.length > 0
        ? `\n\nThings you already posted recently (don't repeat yourself):\n${recentPosts
            .map((p: string) => `- ${p}`)
            .join("\n")}`
        : "";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${directAddress ? "[DIRECT ADDRESS] " : ""}Recent transcript window:\n"""\n${transcriptWindow}\n"""${priorContext}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text : "{}";

    let parsed: { should_post: boolean; message: string; reason?: string };
    try {
      // Take just the {...} part, in case the reply has extra text or code fences.
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("no JSON object");
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      console.error("gate: unparseable model output:", raw);
      parsed = {
        should_post: false,
        message: "",
        reason: `unparseable model output: ${raw.slice(0, 200)}`,
      };
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error("gate error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
