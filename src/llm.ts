/**
 * Pluggable LLM provider for session-digest extraction (v2).
 *
 * Config: REMEMBRA_LLM=openai|anthropic|ollama   (default: openai)
 * Keys:   OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_HOST (default localhost:11434)
 *
 * No SDK dependencies — plain fetch against each provider's HTTP API.
 * All requests go through the provider policy (src/provider.ts): timeout,
 * bounded retries, overall budget, cancellation, error normalization (§3.7).
 */
import {
  createLlmAdapter,
  type LlmAdapter,
  type LlmProviderName,
} from "./provider-adapters.js";
import { MemoryType } from "./types.js";

export type LlmProvider = LlmProviderName;
export type { LlmAdapter } from "./provider-adapters.js";

/** Cancellation plumbed from transports (HTTP disconnect) down to fetch. */
export interface LlmCallOptions {
  signal?: AbortSignal;
  /** Optional injected/local adapter; takes precedence over the legacy provider name. */
  adapter?: LlmAdapter;
}

export interface ExtractedMemory {
  /** One of the eleven semantic types (plan §4.1) — validated in parseExtraction. */
  type: MemoryType;
  content: string;
  tags: string[];
  importance: number;
  /** Optional scope override; falls back to the digest call's scope. */
  scope?: string;
  /** Optional 0..1 confidence from the extraction LLM (service default: 0.7). */
  confidence?: number;
}

export function resolveLlmProvider(): LlmProvider {
  const v = (process.env.REMEMBRA_LLM ?? "openai").toLowerCase();
  if (v === "openai" || v === "anthropic" || v === "ollama") return v;
  throw new Error(`Invalid REMEMBRA_LLM "${v}" — expected openai|anthropic|ollama`);
}

const SYSTEM_PROMPT = `You extract long-term memories from a conversation transcript.
Return ONLY a JSON array (no prose, no markdown fence). Each element:
{"type":"<one of the eleven types>","content":"<standalone statement>","tags":["..."],"importance":1-5}

Type semantics (pick the most specific that fits):
- "fact": stable knowledge about the user, their work, or the world worth keeping.
- "preference": how the user likes things done (tone, tools, formats, workflows).
- "decision": a choice that was already made (not a plan or an idea).
- "constraint": a hard limitation that must be respected (budgets, deadlines, must-not rules).
- "instruction": a standing directive for future sessions (what to always do, how to act).
- "role": who the assistant is for this user/team (persona, duties, expertise).
- "entity": a durable thing described once and referenced later (person, org, tool, project).
- "relationship": how two entities are connected (works-with, part-of, reports-to).
- "event": a single notable occurrence with a time (launch, outage, meeting outcome).
- "history": a condensed chronology of past work (versions, migrations, phases).
- "observation": a noteworthy but tentative note from this session (not yet a stable fact).

Rules:
- Write each content as a self-contained statement (no "we discussed" or "earlier").
- Skip small talk, pleasantries, and anything already obvious from the transcript's task.
- importance: 5 = critical, 1 = trivia. Default 3.
- confidence (optional): 0..1 how sure you are the statement is accurate as written.
- If nothing is worth keeping, return [].
- Output must be valid JSON parseable directly.`;

export async function extractMemories(
  transcript: string,
  provider: LlmProvider = resolveLlmProvider(),
  opts?: LlmCallOptions,
): Promise<ExtractedMemory[]> {
  const text = await chat(provider, SYSTEM_PROMPT, transcript, opts);
  return parseExtraction(text);
}

async function chat(
  provider: LlmProvider,
  system: string,
  user: string,
  opts?: LlmCallOptions,
): Promise<string> {
  const adapter = opts?.adapter ?? createLlmAdapter(provider);
  return adapter.complete({ system, user }, { signal: opts?.signal });
}

// ---------------------------------------------------------------------------
// Contradiction merge (v3): decide whether a new item duplicates, supersedes
// or is novel relative to a stored memory — and produce the merged text.
// ---------------------------------------------------------------------------

export type MergeDecision =
  | { action: "store" } // novel — store it as-is
  | { action: "skip" } // same fact, already covered
  | { action: "merge"; content: string }; // new truth — merged text (old preserved by caller)

const MERGE_PROMPT = `You compare a NEW memory with an EXISTING stored memory and decide what to do.
Return ONLY JSON: {"action":"store"|"skip"|"merge","content":"<merged text>"}

- "skip": they say the same thing (paraphrase is fine) — the existing memory already covers it.
- "merge": the new one is a newer version of the same fact (a changed value, evolved decision,
  refined wording). "content" = the updated statement ONLY (state the current truth, no history).
- "store": unrelated or complementary — store it separately.
Omit "content" unless action is "merge".`;

export async function resolveMerge(
  newContent: string,
  existing: { type: string; content: string },
  provider: LlmProvider = resolveLlmProvider(),
  opts?: LlmCallOptions,
): Promise<MergeDecision> {
  const user = `EXISTING (${existing.type}): ${existing.content}\nNEW: ${newContent}`;
  const raw = await chat(provider, MERGE_PROMPT, user, opts);
  let parsed: { action?: string; content?: string };
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    parsed = JSON.parse(text);
  } catch {
    return { action: "store" }; // fail open: never lose an item because parsing broke
  }
  if (parsed.action === "skip") return { action: "skip" };
  if (parsed.action === "merge" && typeof parsed.content === "string" && parsed.content.trim()) {
    return { action: "merge", content: parsed.content.trim() };
  }
  return { action: "store" };
}

/** Parse the model's reply into extracted memories, tolerating code fences. */
export function parseExtraction(raw: string): ExtractedMemory[] {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some models wrap it as {"memories":[...]} — try once more.
    try {
      const obj = JSON.parse(raw.trim());
      parsed = Array.isArray(obj) ? obj : (obj.memories ?? obj.items ?? []);
    } catch {
      throw new Error(`Could not parse extraction output: ${raw.slice(0, 200)}`);
    }
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedMemory[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const type = (item as Record<string, unknown>).type;
    const content = (item as Record<string, unknown>).content;
    if (typeof content !== "string" || !content.trim()) continue;
    if (typeof type !== "string" || !(MemoryType.options as readonly string[]).includes(type)) continue;
    const tags = (item as Record<string, unknown>).tags;
    const importance = Number((item as Record<string, unknown>).importance);
    const scope = (item as Record<string, unknown>).scope;
    const confidence = Number((item as Record<string, unknown>).confidence);
    out.push({
      type: type as MemoryType,
      content: content.trim(),
      tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
      importance: Number.isFinite(importance) ? Math.min(5, Math.max(1, Math.round(importance))) : 3,
      scope: typeof scope === "string" && scope.trim() ? scope.trim() : undefined,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : undefined,
    });
  }
  return out;
}
