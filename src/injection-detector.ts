/**
 * Prompt injection pattern detector (V4.4.0, plan §7.6).
 *
 * Scans memory content for patterns that attempt to manipulate:
 * - Role/instruction override
 * - System prompt leakage
 * - Jailbreak patterns
 * - Metadata trust/retention manipulation
 *
 * Returns flagged matches; storage decision is left to the caller.
 */

const DEFAULT_PATTERNS = [
  // Role/instruction override
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /you\s+are\s+now\s+/i,
  /from\s+now\s+on\s+/i,
  /your\s+new\s+instruction/i,
  /disregard\s+any\s+prior/i,
  // System prompt leakage
  /output\s+your\s+system\s+prompt/i,
  /reveal\s+your\s+instructions/i,
  /show\s+me\s+your\s+prompt/i,
  /what\s+were\s+you\s+told\s+to\s+do/i,
  /print\s+your\s+system\s+message/i,
  // Jailbreak patterns
  /\bDAN\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bunleashed\b/i,
  /\bjailbreak\b/i,
  /\boverride\s+security\b/i,
  // Trust/retention manipulation
  /set\s+your\s+trust\s+to/i,
  /change\s+your\s+retention/i,
  /bypass\s+trust\s+gate/i,
  /skip\s+verification/i,
] as RegExp[];

export interface InjectionResult {
  /** Whether any pattern matched. */
  flagged: boolean;
  /** List of matched pattern descriptions. */
  matches: string[];
}

export class InjectionDetector {
  private readonly patterns: RegExp[];

  constructor(customPatterns?: string[]) {
    this.patterns = [...DEFAULT_PATTERNS];
    if (customPatterns) {
      for (const p of customPatterns) {
        try {
          this.patterns.push(new RegExp(p, "i"));
        } catch {
          // Invalid regex — skip.
        }
      }
    }
  }

  /**
   * Scan text for injection patterns.
   * Returns result with flagged status and match descriptions.
   */
  scan(text: string): InjectionResult {
    const matches: string[] = [];
    for (const pattern of this.patterns) {
      if (pattern.test(text)) {
        matches.push(pattern.source);
      }
    }
    return {
      flagged: matches.length > 0,
      matches,
    };
  }
}

/** Singleton instance using env-configured patterns. */
export function createInjectionDetector(): InjectionDetector {
  const custom = process.env.REMEMBRA_INJECTION_PATTERNS
    ? process.env.REMEMBRA_INJECTION_PATTERNS.split(",").map((s) => s.trim())
    : undefined;
  return new InjectionDetector(custom);
}
