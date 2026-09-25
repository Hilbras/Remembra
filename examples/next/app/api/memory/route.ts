/**
 * Next.js example: a server route that keeps the API key server-side.
 *
 * The browser calls this route; the route calls Remembra. `REMEMBRA_API_KEY`
 * is never exposed to the client bundle.
 *
 * Copy this file to `app/api/memory/route.ts` in a Next.js app.
 */
import { NextResponse } from "next/server";
import { Remembra } from "@hilbras/remembra/sdk";

const client = new Remembra({
  endpoint: process.env.REMEMBRA_ENDPOINT ?? "http://127.0.0.1:8787",
  apiKey: process.env.REMEMBRA_API_KEY,
});

export async function POST(request: Request) {
  const { text } = (await request.json()) as { text?: string };
  if (typeof text !== "string" || text.length === 0 || text.length > 2_000) {
    return NextResponse.json({ error: "text must be 1-2000 characters" }, { status: 400 });
  }
  try {
    const stored = await client.store({ type: "fact", content: text, importance: 5 });
    return NextResponse.json({ id: stored.id }, { status: 201 });
  } catch (error) {
    // Report a stable code; never forward provider or server diagnostics.
    const code = (error as { code?: string }).code ?? "SERVICE_UNAVAILABLE";
    return NextResponse.json({ error: "the memory could not be stored", code }, { status: 503 });
  }
}
