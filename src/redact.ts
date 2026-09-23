/**
 * Content redaction filter for PII (audit Phase 8).
 *
 * Opt-in: REMEMBRA_REDACT=1|true|yes. Applied at the service ingest layer
 * (memory_store + every digest item/merge) so raw PII never reaches disk,
 * embeddings, or export snapshots.
 *
 * Design notes:
 * - Patterns run most-specific first: cards before phones, prefixes before
 *   generic long tokens — each match is replaced by a typed placeholder so
 *   downstream text stays readable ("<EMAIL> confirmed the deploy").
 * - Cards must pass the Luhn check — digit soup that is not a valid card
 *   number stays untouched (false positives here would be worse than misses).
 * - Phone matching requires separators and 10–15 digits, so dates
 *   (2026-09-23 → 8 digits) and versions (3.6.0) never match.
 * - Redaction is IRREVERSIBLE by design: the original bytes are not kept
 *   anywhere (including in the LLM-visible transcript only at extraction —
 *   see docs/security.md).
 */

export type RedactionKind = "email" | "ssn" | "card" | "phone" | "secret";

export interface RedactionResult {
  text: string;
  counts: Partial<Record<RedactionKind, number>>;
  changed: boolean;
}

export function redactionEnabled(): boolean {
  const v = (process.env.REMEMBRA_REDACT ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Luhn mod-10 — rejects digit groups that merely look card-shaped. */
function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Optional extra test on the raw match (e.g. Luhn, digit count). */
  accept?: (match: string) => boolean;
}

// Order matters: specific formats first.
const RULES: Rule[] = [
  { kind: "email", pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { kind: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    // 13–19 digits, optionally grouped by spaces/dashes: `4111 1111 1111 1111`
    kind: "card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m) => luhnOk(m.replace(/[ -]/g, "")),
  },
  {
    // Requires separators AND 10–15 total digits (dates/versions excluded).
    // Lookbehind keeps the match at the token start (a leading `+` is not a
    // word boundary); the paren form consumes its own `)`.
    kind: "phone",
    pattern: /(?<=^|\s)(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]\d{3,4}\b/g,
    accept: (m) => {
      const digits = m.replace(/\D/g, "").length;
      return digits >= 10 && digits <= 15;
    },
  },
  // Provider token shapes: OpenAI sk-..., GitHub ghp_/gho_/github_pat-, AWS AKIA…,
  // Slack xoxb-, GitLab glpat-, generic <prefix><32+ chars>.
  {
    kind: "secret",
    pattern: /\b(?:sk|pk|rk|ghp|gho|ghs|xoxb|xoxp|glpat)[-_][A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bghu_[A-Za-z0-9]{20,}\b|github_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    // High-entropy blob: 40+ unbroken base64/hex-ish chars (keys, hashes).
    // UUIDs are 36 chars with dashes; English words never reach 40.
    kind: "secret",
    pattern: /\b[A-Za-z0-9+/_-]{40,}\b/g,
    accept: (m) => !/^[\w-]+$/.test(m) || /[0-9]/.test(m), // require a digit: skips megawords
  },
];

/** Redact PII patterns out of text, returning what was found. */
export function redact(text: string): RedactionResult {
  const counts: Partial<Record<RedactionKind, number>> = {};
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match) => {
      if (rule.accept && !rule.accept(match)) return match;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      return `<${rule.kind.toUpperCase()}>`;
    });
  }
  return { text: out, counts, changed: Object.keys(counts).length > 0 };
}

/** Redact a tag list (tags are short, but emails/secrets do sneak in). */
export function redactTags(tags: string[]): { tags: string[]; counts: Partial<Record<RedactionKind, number>> } {
  const merged: Partial<Record<RedactionKind, number>> = {};
  let changed = false;
  const out = tags.map((t) => {
    const r = redact(t);
    for (const [k, v] of Object.entries(r.counts)) {
      merged[k as RedactionKind] = (merged[k as RedactionKind] ?? 0) + (v as number);
    }
    if (r.changed) changed = true;
    return r.text;
  });
  return { tags: out, counts: changed ? merged : {} };
}
