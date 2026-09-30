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
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEXICAL_WEIGHTS,
  extractQuery,
  keywordScore,
  searchQ,
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

/**
 * Audit finding S7: the query side and the document side had two different ideas of
 * what a token is.
 *
 * `tokenize` segmented CJK per character, and the audit credited it with CJK
 * support. It had none. `extractQuery` filtered query terms with
 * `/^[a-z0-9]+$/u`, so **every** non-ASCII query produced zero terms, no keyword
 * list was built, and retrieval fell back to the vector path alone — which is
 * nothing at all when no embedding provider is configured. The user got an empty
 * result set rather than an error or a degraded result.
 *
 * The failure mode was silence, which is why nothing caught it: a query returning
 * nothing is indistinguishable from a query with no match.
 *
 * One correction to the audit while fixing it. It claimed `CJK_RANGE` did not match
 * katakana. It does — the range includes `\u3040-\u30ff`, and both katakana and
 * hiragana segment per character correctly. The *wider* problem is that Hangul,
 * Thai, Greek and Cyrillic were also unreachable, and for those per-character
 * segmentation is wrong: they tokenise as whole words, and that is already what the
 * document side does.
 */
describe("S7: the query side segments text the way the document side does", () => {
  /** A document with a chosen id and embedding, which the shared `mem` helper does not take. */
  const doc = (id: string, content: string, embedding: number[]): Memory => ({
    ...mem(content),
    id,
    embedding,
  });

  test("S7-001: scripts that segment per character yield per-character terms", () => {
    // Chinese, Japanese katakana and hiragana. Each term is one character long, which
    // is the point: a length filter alone would drop every one of them.
    assert.deepEqual(extractQuery("记录回滚").terms, ["记", "录", "回", "滚"]);
    assert.deepEqual(extractQuery("デプロイ").terms, ["デ", "プ", "ロ", "イ"]);
    assert.deepEqual(extractQuery("ひらがな").terms, ["ひ", "ら", "が", "な"]);
  });

  test("S7-002: scripts that segment as whole words yield whole-word terms", () => {
    // Not per character. These scripts tokenise as words on the document side, and a
    // query that segmented differently would never match one.
    assert.deepEqual(extractQuery("한글").terms, ["한글"]);
    assert.deepEqual(extractQuery("ไทย").terms, ["ไทย"]);
    assert.deepEqual(extractQuery("Привет").terms, ["привет"]);
    assert.deepEqual(extractQuery("Αθήνα").terms, ["αθήνα"]);
  });

  test("S7-003: a CJK query finds a CJK document", () => {
    // End to end, because per-character terms are only useful if the document side
    // produced the same units. Before the fix this returned no results at all.
    const cjk = doc("cjk", "部署记录的回滚流程", [0, 0, 0, 0]);
    const ascii = doc("ascii", "the rollback runbook is in the wiki", [0, 0, 0, 1]);
    const hits = searchQ([cjk, ascii], { query: "记录回滚", explain: true }, null, { diversity: false });
    assert.equal(hits.results[0]?.id, cjk.id, "the CJK document is found and leads");
    const keyword = (hits.explanations ?? []).find((e) => e.id === cjk.id)?.components.keyword ?? 0;
    assert.ok(keyword > 0, `and it matched lexically rather than on modifiers alone (keyword=${keyword})`);
    // The ASCII document shares no terms, so this is not a "everything matches" pass.
    const asciiKeyword = (hits.explanations ?? []).find((e) => e.id === ascii.id)?.components.keyword ?? 0;
    assert.equal(asciiKeyword, 0, "an unrelated document still scores nothing");
  });

  test("S7-004: ASCII behaviour is unchanged", () => {
    // The cases the old filter handled, asserted so sharing the tokeniser did not
    // quietly change them.
    assert.deepEqual(extractQuery("deployment pipeline").terms, ["deployment", "pipeline"]);
    assert.deepEqual(extractQuery("r2d2").terms, ["r2d2"]);
    assert.deepEqual(extractQuery("a b c").terms, [], "single ASCII letters were dropped before and still are");
    assert.deepEqual(extractQuery("C++").terms, [], "and a run with no alphanumeric core still is");
  });

  test("S7-005: the one ASCII behaviour change, pinned deliberately", () => {
    // "don't" used to contribute no term at all, because the whole whitespace-delimited
    // run had to be alphanumeric. It now contributes "don", because the tokeniser
    // splits punctuation and the document side has always done the same — so a query
    // for a possessive can now match a document containing it, which it could not
    // before. Pinned here rather than left incidental: a change that is intended
    // should be visible, and a change that is not intended should fail a test.
    assert.deepEqual(extractQuery("don't").terms, ["don"]);
    const target = doc("possessive", "the user's preferences are stored", [0, 0, 0, 1]);
    const hits = searchQ([target], { query: "user's" }, null, { diversity: false });
    assert.equal(hits.results.length, 1, "and it matches, which it did not before");
  });

  test("S7-006: a non-ASCII body segments even when the query is qualifier-only", () => {
    // A bare qualifier still parses, and the body after it still tokenises. Kept
    // narrow on purpose: `latest 3 <query>` does *not* work, for a reason that has
    // nothing to do with segmentation. That is S7-007, pinned there.
    const parsed = extractQuery("latest 3");
    assert.equal(parsed.temporal.latestCount, 3);
    assert.deepEqual(parsed.terms, []);

    const plain = extractQuery("记录回滚");
    assert.deepEqual(plain.terms, ["记", "录", "回", "滚"]);
  });

  test("S7-007: a temporal qualifier with a trailing body does not parse at all", () => {
    // Audit S8, found while writing S7-006 and unrelated to segmentation.
    //
    // `TEMPORAL_RE` anchors the alternation with `$`, so each branch must consume
    // the *entire* query. `latest(?:\\s+(\\d+))` matches "latest 3" and leaves
    // "记录回滚" unconsumed, the anchor fails, no branch matches — and the qualifier
    // is then tokenised as an ordinary word. So "latest 3 errors" searches for the
    // literal words *latest* and *errors*: no recency boost, no "N most recent"
    // limit, and a ranking that looks plausible because it is just a keyword search.
    //
    // Pinned here rather than in a dedicated file because it was found next to it,
    // and a failing-looking assertion in an unrelated test would be worse. The fix is
    // to let the qualifier branches carry a trailing remainder, which is what the
    // `before`/`after` branches already do with `(.+)`.
    const parsed = extractQuery("latest 3 记录回滚");
    assert.equal(parsed.temporal.latestCount, undefined, "the qualifier is not recognised");
    assert.ok(
      parsed.terms.includes("latest"),
      "and it becomes a search term instead \u2014 which is the bug: the words are searched for as if the user meant them",
    );
  });
});
