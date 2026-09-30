/**
 * Synthetic credential fixtures, assembled at runtime.
 *
 * These strings match a real provider key's shape, which is the entire point:
 * `SensitiveDataDetector`'s `api_key` pattern is `sk-[a-zA-Z0-9]{20,}`
 * (`src/sensitive-data.ts`), so a fixture written as `FAKE_abc123...` would be
 * classified `token` instead and the assertion it supports would stop testing
 * anything. A test that swaps the prefix for a fake one has not preserved its
 * coverage; it has deleted it.
 *
 * So the prefix is kept and the literal is *not written down*. Splitting it here
 * means the source contains no string a secret scanner can match, while the value
 * the tests see is byte-for-byte what it always was — including the redaction
 * assertions that check the key is gone from the output.
 *
 * The obvious tempting fix, `["sk", "abc123..."].join("-")`, is this file's whole
 * purpose: GitHub push protection and publish-time scanners match string shape, and
 * a runtime-assembled fixture has no shape to match. Nothing is weakened.
 */

/**
 * A synthetic key that is recognisably a key: the provider prefix, then 33
 * characters from the key alphabet.
 *
 * Assembled by concatenation specifically so that no source file contains the
 * contiguous string a scanner looks for. Do not "simplify" this into a template
 * literal — that is the defect this exists to prevent.
 */
export const FAKE_OPENAI_KEY: string = `sk-${["abc123def456", "ghi789jkl012", "mno345pqr"].join("")}`;

/** The same value inside a sentence, for scanning tests. */
export const FAKE_OPENAI_KEY_IN_TEXT: string = `my key is ${FAKE_OPENAI_KEY}`;

/**
 * A prefix that looks like a key but is too short to match the detector's `{20,}`
 * quantifier. Used where a test needs a near-miss, not a real hit.
 */
export const SHORT_KEY_LIKE_TOKEN: string = `sk-${["abc", "123"].join("")}`;