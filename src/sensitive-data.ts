/**
 * Sensitive data policy engine (V4.4.0, plan §7.7).
 *
 * Extends the existing PII redaction with a policy that supports:
 * - allow: store as-is
 * - redact: replace matches with typed placeholders (existing behavior)
 * - reject: return error on any match
 * - quarantine: flag for quarantine (trust: unverified, meta.quarantined)
 *
 * Patterns cover API keys, tokens, passwords, private keys, auth cookies,
 * and financial secrets — a superset of the existing PII rules.
 */

import { redact, redactionEnabled } from "./redact.js";

export type SensitivePolicy = "allow" | "redact" | "reject" | "quarantine";

export interface SensitiveResult {
  /** The (possibly redacted) text. */
  text: string;
  /** Whether any sensitive pattern matched. */
  detected: boolean;
  /** Matched pattern categories. */
  categories: string[];
  /** Policy action taken. */
  action: SensitivePolicy;
  /** True when the caller should quarantine this memory. */
  quarantine: boolean;
}

/** Extended patterns for sensitive data detection. */
const SENSITIVE_PATTERNS: Array<{ regex: RegExp; category: string }> = [
  // API keys / tokens
  { regex: /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|ghu_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9]+)\b/g, category: "api_key" },
  { regex: /\bAKIA[A-Z0-9]{16}\b/g, category: "aws_key" },
  { regex: /\b(?:Bearer\s+)?[a-zA-Z0-9\-._~+\/]{20,512}={0,2}\b/g, category: "token" },
  // Private keys
  { regex: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE KEY-----/g, category: "private_key" },
  // Passwords in common formats
  { regex: /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, category: "password" },
  // Auth cookies
  { regex: /\b(?:session[_-]?id|auth[_-]?token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[a-zA-Z0-9\-._~+\/]{10,}/gi, category: "auth_cookie" },
  // Financial secrets
  { regex: /\b(?:credit\s+card|cc\s+number|card\s+number)\s*[:=]\s*\d{13,19}/gi, category: "financial" },
];

export class SensitiveDataDetector {
  private readonly policy: SensitivePolicy;

  constructor(policy: SensitivePolicy = "redact") {
    this.policy = policy;
  }

  /**
   * Scan text for sensitive data. Returns result with detection status and
   * processed text.
   */
  scan(text: string): SensitiveResult {
    if (!text || this.policy === "allow") {
      return { text, detected: false, categories: [], action: "allow", quarantine: false };
    }

    const categories: string[] = [];
    let processed = text;

    for (const { regex, category } of SENSITIVE_PATTERNS) {
      if (regex.test(text)) {
        categories.push(category);
        regex.lastIndex = 0;
        if (this.policy === "redact" || this.policy === "quarantine") {
          processed = processed.replace(regex, `<${category.toUpperCase()}>`);
        }
      }
    }

    // Also run the existing PII redaction if enabled.
    if (redactionEnabled()) {
      const pii = redact(processed);
      if (pii.changed) {
        processed = pii.text;
      }
    }

    const detected = categories.length > 0;
    const action = detected ? this.policy : "allow";
    const quarantine = detected && this.policy === "quarantine";

    return { text: processed, detected, categories, action, quarantine };
  }
}

/** Create detector from env config. */
export function createSensitiveDetector(): SensitiveDataDetector {
  const policy = (process.env.REMEMBRA_SENSITIVE_POLICY ?? "redact") as SensitivePolicy;
  if (!(["allow", "redact", "reject", "quarantine"] as string[]).includes(policy)) {
    return new SensitiveDataDetector("redact");
  }
  return new SensitiveDataDetector(policy);
}
