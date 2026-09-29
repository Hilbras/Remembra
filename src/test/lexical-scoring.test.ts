/**
 * V5.7.0 T02 — token boundaries, phrases, and field weights.
 *
 * Every case here is a row from the V5.7.0 audit's reproduction table, promoted
 * to a test. The old implementation scored all of them with one
 * `String.includes`; each of these was a specific, verified way it ranked the
 * wrong thing.
 *
 * Assertions are on **relative order**, not absolute values, because retrieval
 * only cares about order and T03 is about to replace the idf term. A test
 * asserting `60.00` would be asserting the placeholder, not the behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEXICAL_WEIGHTS,
  keywordScore,
  tokenize,
  type LexicalWeights,
} from "../retrieval.js";
import type { Memory } from "../types.js";

let seq = 0;
function mem(content: string, tags: string[] = []): Memory {
  seq++;
  return {
    id: `m${String(seq).padStart(3, "0")}`,
    type: "fact",
    content,
    scope: "global",
    tags,
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual" },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Score with no corpus statistics, which is the V5.7.0 T02 behaviour. */
const score = (m: Memory, terms: string[], w?: Partial<LexicalWeights>) =>
  keywordScore(m, terms, w ? { ...DEFAULT_LEXICAL_WEIGHTS, ...w } : DEFAULT_LEXICAL_WEIGHTS);

// --- Tokenizer -------------------------------------------------------------

test("T02-001: the tokenizer splits on non-alphanumerics and keeps whole words", () => {
  assert.deepEqual(tokenize("The cat, sat!"), ["the", "cat", "sat"]);
  assert.deepEqual(tokenize("deploy-failed_again"), ["deploy", "failed", "again"]);
  assert.deepEqual(tokenize("   "), []);
  assert.deepEqual(tokenize("v5.6.0 ships"), ["v5", "6", "0", "ships"]);
});

test("T02-002: CJK is tokenized per character, not as one run", () => {
  // CJK is not space-delimited, so a whole run would only ever match identical
  // runs and single characters would be unmatchable.
  assert.deepEqual(tokenize("部署失败"), ["部", "署", "失", "败"]);
  assert.ok(score(mem("部署失败"), ["失"]) > 0, "a single CJK character is matchable");
});

// --- The audit's S1 row: the substring collision --------------------------

test("T02-003: a word that merely contains the term scores nothing, not a tie", () => {
  // The audit's headline row: under the old `includes`, "concatenate the streams"
  // and "the cat sat" both scored 60.00 for the query `cat`.
  //
  // The collision is *mid-word*, not a prefix — "concatenate".startsWith("cat") is
  // false; the letters appear at index 3. I had written this test expecting a
  // positive prefix score, which would have been asserting the wrong mechanism.
  const exact = score(mem("the cat sat"), ["cat"]);
  const embedded = score(mem("concatenate the streams"), ["cat"]);
  assert.ok(exact > 0, "the real match still scores");
  assert.equal(embedded, 0, "a mid-word substring is not lexical evidence at all");
});

test("T02-004: a mid-word match is not a match at all", () => {
  // "port" appears inside "transport" and "exported" but not at the start, so it is
  // not a prefix match either. This is the case substring matching got worst.
  const exact = score(mem("the port is closed"), ["port"]);
  const midWord = score(mem("the transport layer"), ["port"]);
  assert.ok(exact > 0);
  assert.equal(midWord, 0, "a match in the middle of a word is not lexical evidence");
});

test("T02-005: prefix matching is a distinct, separately-weighted signal", () => {
  // A true prefix: the token *starts with* the term, so someone searching `deploy`
  // finds `deployment`. This is a weaker signal than an exact match, not the same
  // one, which is why it carries its own weight.
  const exact = score(mem("we deploy often"), ["deploy"]);
  const prefix = score(mem("the deployment failed"), ["deploy"]);
  assert.ok(exact > 0, "an exact token matches");
  assert.ok(prefix > 0, "and so does a token that starts with the term");
  assert.ok(exact > prefix, `exact must outrank prefix: ${exact.toFixed(2)} vs ${prefix.toFixed(2)}`);
  // And the weight is tunable, which is the point of a separate signal.
  const eager = score(mem("the deployment failed"), ["deploy"], { prefix: 0.9 });
  assert.ok(eager > prefix, `raising the prefix weight raises prefix credit: ${eager.toFixed(2)} vs ${prefix.toFixed(2)}`);
  assert.ok(eager < exact, "but even at 0.9 a prefix does not overtake an exact match");
});

// --- The audit's S1 rows: phrase matching --------------------------------

test("T02-006: a phrase in the right order outranks the same words reversed", () => {
  const ordered = score(mem("the red car"), ["red", "car"]);
  const reversed = score(mem("car the red"), ["red", "car"]);
  assert.ok(
    ordered > reversed,
    `adjacent and in order must score higher: ${ordered.toFixed(2)} vs ${reversed.toFixed(2)}`,
  );
});

test("T02-007: a phrase outranks the same words scattered across the document", () => {
  const phrase = score(mem("the red car"), ["red", "car"]);
  const scattered = score(mem("red is a colour and the car is red too"), ["red", "car"]);
  assert.ok(phrase > scattered, `adjacency is worth something: ${phrase.toFixed(2)} vs ${scattered.toFixed(2)}`);
});

test("T02-008: a document containing only one phrase term still scores, but less", () => {
  // Scored, not filtered: dropping it would lose a result the user asked for.
  const partial = score(mem("a red dog here"), ["red", "car"]);
  assert.ok(partial > 0, "one of two terms is partial evidence, not none");
  assert.ok(partial < score(mem("the red car"), ["red", "car"]), "and less than a full phrase");
});

test("T02-009: phrase credit is adjustable and cannot be negative", () => {
  const base = score(mem("the red car"), ["red", "car"]);
  const boosted = score(mem("the red car"), ["red", "car"], { phrase: 2 });
  assert.ok(boosted > base, "a bigger multiplier earns more");
  // phrase: 1 means "no bonus", which must be exactly the un-bonused score.
  // phrase 1 is "no bonus", and the cleanest proof is that it equals a document
  // with the same term credits that simply fails to be a phrase.
  const none = score(mem("the red car"), ["red", "car"], { phrase: 1 });
  const notAPhrase = score(mem("car the red"), ["red", "car"]);
  assert.ok(
    Math.abs(none - notAPhrase) < 1e-9,
    `phrase 1 earns exactly the term credits and no more: ${none.toFixed(3)} vs ${notAPhrase.toFixed(3)}`,
  );
});

// --- The audit's S1 row: field weights -----------------------------------

test("T02-010: a term in the content outranks the same term only in a tag", () => {
  // The old implementation concatenated `content + " " + tags` into one string, so
  // these were identical at 60.00.
  const inBody = score(mem("the widget is broken", ["unrelated"]), ["widget"]);
  const inTag = score(mem("nothing relevant here", ["widget"]), ["widget"]);
  assert.ok(inBody > inTag, `prose must outweigh a tag: ${inBody.toFixed(2)} vs ${inTag.toFixed(2)}`);
});

test("T02-011: a term in both fields scores more than either alone", () => {
  const both = score(mem("the widget is broken", ["widget"]), ["widget"]);
  const body = score(mem("the widget is broken", ["unrelated"]), ["widget"]);
  const tag = score(mem("nothing relevant here", ["widget"]), ["widget"]);
  assert.ok(both > body && both > tag, "fields accumulate");
});

test("T02-012: field weights are configurable and mean what they say", () => {
  const inTag = mem("nothing relevant here", ["widget"]);
  const heavyTags = score(inTag, ["widget"], { tags: 3 });
  const defaultTags = score(inTag, ["widget"]);
  assert.ok(heavyTags > defaultTags, "raising the tag weight raises tag credit");
  // `content` is the unit the others are measured against, so scaling it is a
  // no-op by construction. Pinned deliberately: it is a consequence of the
  // normalisation, and a reader who assumes otherwise will chase a bug that is
  // not there.
  const baseline = score(mem("widget", []), ["widget"]);
  const heavyContent = score(mem("widget", []), ["widget"], { content: 4 });
  assert.equal(heavyContent, baseline, "scaling the unit moves numerator and denominator together");
  // The relative value of a tag *is* tunable, which is the knob that matters.
  assert.ok(
    score(mem("nothing here", ["widget"]), ["widget"], { tags: 2 }) >
      score(mem("nothing here", ["widget"]), ["widget"]),
    "a tag can be made worth more than the unit",
  );
});

// --- Invariants the change must not break --------------------------------

test("T02-013: no lexical evidence scores exactly zero, so `keyword_hit` stays honest", () => {
  // `searchQ` pushes the "keyword_hit" explanation when kwScore > 0. A scoring
  // change that leaked a positive score onto an unrelated memory would make the
  // explanation a lie.
  assert.equal(score(mem("completely unrelated text", ["nope"]), ["widget"]), 0);
  assert.equal(score(mem("concatenate everything", []), ["zebra"]), 0);
});

test("T02-014: an empty term list scores zero, not the old 10-point floor", () => {
  assert.equal(score(mem("anything at all"), []), 0);
});

test("T02-015: coverage is capped at 60, so the scale downstream expects is preserved", () => {
  // `score()` and any threshold in the legacy path depend on the 0..60 shape.
  const dense = keywordScore(
    mem("alpha beta gamma delta epsilon"),
    ["alpha", "beta", "gamma", "delta", "epsilon"],
  );
  assert.ok(dense <= 60, `never exceeds the cap: ${dense}`);
  assert.ok(dense > 0);
});

test("T02-016: the weights are frozen, so a caller cannot mutate the defaults", () => {
  assert.throws(() => {
    (DEFAULT_LEXICAL_WEIGHTS as { content: number }).content = 99;
  });
});
