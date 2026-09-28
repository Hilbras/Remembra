/**
 * Verifies the Lua script bodies shipped in src/redis.ts against a Lua 5.3 VM
 * (fengari) with a shim of the Redis commands they use.
 *
 * This harness is not part of the committed test suite: fengari is not a
 * dependency of this package and Lua is not a runtime requirement. It exists
 * because the Lua is the substance of the shared-quota guarantee and there is no
 * Redis server in this environment, and "reviewed but never executed" is not a
 * good place to leave the atomicity argument.
 *
 * The scripts are extracted from the source rather than copied, so this cannot
 * pass against a stale copy of them.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let fengari;
try {
  fengari = require("fengari");
} catch {
  console.error(
    "This verification needs a Lua VM and fengari is not installed.\n" +
      "  npm install --no-save fengari && node scripts/verify-redis-lua.mjs\n" +
      "It is deliberately not a release gate: a Lua VM is not a runtime\n" +
      "requirement of this package, and adding one to make a check pass would\n" +
      "trade a real constraint for a comfortable green.",
  );
  process.exit(2);
}
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const SOURCE = readFileSync(new URL("../src/redis.ts", import.meta.url), "utf8");

function scriptNamed(name) {
  const marker = `const ${name} = \``;
  const start = SOURCE.indexOf(marker);
  if (start < 0) throw new Error(`could not find ${name} in src/redis.ts`);
  const from = start + marker.length;
  const end = SOURCE.indexOf("`", from);
  return SOURCE.slice(from, end);
}

const SCRIPTS = {
  QUOTA: scriptNamed("QUOTA_SCRIPT"),
  QUOTA_CHECK: scriptNamed("QUOTA_CHECK_SCRIPT"),
  RELEASE: scriptNamed("RELEASE_SCRIPT"),
  RENEW: scriptNamed("RENEW_SCRIPT"),
};
for (const [name, body] of Object.entries(SCRIPTS)) {
  if (body.includes("]==]")) throw new Error(`${name} contains the Lua long-string delimiter`);
}

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

function runChunk(source) {
  if (lauxlib.luaL_loadbuffer(L, to_luastring(source), null, to_luastring("=chunk")) !== lua.LUA_OK) {
    throw new Error(`lua load failed: ${to_jsstring(lua.lua_tostring(L, -1))}`);
  }
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
    throw new Error(`lua error: ${to_jsstring(lua.lua_tostring(L, -1))}`);
  }
  const type = lua.lua_type(L, -1);
  let out;
  if (type === lua.LUA_TNIL) {
    out = "";
  } else if (type === lua.LUA_TSTRING) {
    out = to_jsstring(lua.lua_tostring(L, -1));
  } else if (type === lua.LUA_TNUMBER) {
    out = lua.lua_tonumber(L, -1);
  } else {
    throw new Error(`expected a string or number reply, got lua type ${type}`);
  }
  lua.lua_settop(L, -2);
  return out;
}

runChunk(readFileSync(new URL("./redis-shim.lua", import.meta.url), "utf8"));

const quote = (value) => `"${String(value).replace(/["\\]/g, "\\$&")}"`;

/** Evaluate a script the way Redis does: KEYS/ARGV as globals, body returns the reply. */
function evaluate(name, keys, argv) {
  const source =
    `KEYS = { ${keys.map(quote).join(", ")} }\n` +
    `ARGV = { ${argv.map((value) => quote(value)).join(", ")} }\n` +
    `return run_script([==[${SCRIPTS[name]}]==])`;
  return runChunk(source).split(",").map(Number);
}

function setKey(key, value) {
  runChunk(`store[${quote(key)}] = ${quote(value)}`);
}
function keyExists(key) {
  return runChunk(`local v = store[${quote(key)}]\nif v == nil then return 0 end\nreturn 1`) === 1;
}
function zcard(key) {
  return Number(runChunk(`local e = store[${quote(key)}]\nif e == nil then return 0 end\nreturn #e.entries`));
}

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`  ✖ ${label}\n      expected ${e}\n      actual   ${a}`);
  } else {
    console.log(`  ✔ ${label}`);
  }
}

const reset = () => void runChunk("reset()");

// --- S1: under the limit is allowed and reports what is left ---------------
console.log("S1: a request under the limit is charged once and reports the remainder");
reset();
check("first request allowed, remaining 2 of 3", evaluate("QUOTA", ["q:base=k"], [0, "m1", 3, 60_000]), [1, 0, 2, 0]);
check("the base key holds exactly one entry", zcard("q:base=k"), 1);

// --- S2: at the limit is refused, with a retry hint ----------------------
console.log("S2: the request that would exceed the limit is refused, and says when to retry");
reset();
evaluate("QUOTA", ["q:base=k"], [0, "m1", 3, 60_000]);
evaluate("QUOTA", ["q:base=k"], [0, "m2", 3, 60_000]);
check("third request allowed, remaining 0", evaluate("QUOTA", ["q:base=k"], [0, "m3", 3, 60_000]), [1, 0, 0, 0]);
check("fourth refused, retry after a full window", evaluate("QUOTA", ["q:base=k"], [0, "m4", 3, 60_000]), [0, 1, 0, 60_000]);
check("a refused request charges nothing", zcard("q:base=k"), 3);

// --- S3: each dimension keeps its own window ------------------------------
// This is the defect that made a 60-per-minute budget behave as 60-per-hour:
// pruning every key against the largest window left the short window's stale
// entries in place, so ZCARD counted hours-old requests.
console.log("S3: a short window ages out on its own schedule, not the longest one's");
reset();
const s3 = [
  ["q:user=u1", 2, 60_000],
  ["q:base=k1", 100, 3_600_000],
];
const s3argv = (now, member) => [now, member, ...s3.flatMap(([, limit, window]) => [limit, window])];
check("first user request allowed", evaluate("QUOTA", s3.map(([k]) => k), s3argv(0, "a")), [1, 0, 1, 0]);
check("second user request exhausts the user budget", evaluate("QUOTA", s3.map(([k]) => k), s3argv(0, "b")), [1, 0, 0, 0]);
check("third is refused by the user dimension", evaluate("QUOTA", s3.map(([k]) => k), s3argv(0, "c")), [0, 1, 0, 60_000]);
check("after 61s the user window has reset and the request is allowed again", evaluate("QUOTA", s3.map(([k]) => k), s3argv(61_000, "d")), [1, 0, 1, 0]);
check("the hour-long base window kept both its entries", zcard("q:base=k1"), 3);

// --- S4: the first refusing dimension in precedence order decides ---------
console.log("S4: the refusal is attributed to the dimension that refused, by key position");
reset();
check(
  "organization is exhausted and decides, even though its key is second",
  evaluate("QUOTA", ["q:user=u1", "q:organization=o1", "q:base=k1"], [0, "a", 100, 60_000, 1, 60_000, 100, 60_000]),
  [1, 0, 0, 0],
);
check(
  "the next request is refused and points at key 2",
  evaluate("QUOTA", ["q:user=u1", "q:organization=o1", "q:base=k1"], [0, "b", 100, 60_000, 1, 60_000, 100, 60_000]),
  [0, 2, 0, 60_000],
);
check(
  "the allowed call charged all three, and the refused one charged none",
  [zcard("q:user=u1"), zcard("q:organization=o1"), zcard("q:base=k1")],
  [1, 1, 1],
);

// --- S5: a duplicate member would be silently overwritten ----------------
// This is why `member()` includes an instance tag and a counter: with the same
// member twice in the same millisecond, ZADD overwrites and the second request
// never enters the count, so the limit is not enforced at all.
console.log("S5: sorted-set members must be unique or a request goes uncounted");
reset();
evaluate("QUOTA", ["q:base=k"], [0, "same", 3, 60_000]);
evaluate("QUOTA", ["q:base=k"], [0, "same", 3, 60_000]);
check("the same member twice leaves one entry", zcard("q:base=k"), 1);
check(
  "and so the third request is still allowed, having counted only one of the three",
  evaluate("QUOTA", ["q:base=k"], [0, "same", 3, 60_000]),
  [1, 0, 2, 0],
);
check("distinct members in one millisecond all count", (() => {
  reset();
  evaluate("QUOTA", ["q:base=k"], [0, "a", 3, 60_000]);
  evaluate("QUOTA", ["q:base=k"], [0, "b", 3, 60_000]);
  return zcard("q:base=k");
})(), 2);

// --- S6: a check charges nothing -----------------------------------------
console.log("S6: a speculative check reads the decision without spending it");
reset();
evaluate("QUOTA", ["q:base=k"], [0, "a", 5, 60_000]);
check("check reports what is left", evaluate("QUOTA_CHECK", ["q:base=k"], [0, "unused", 5, 60_000]), [1, 0, 4, 0]);
check("checking twice does not spend twice", evaluate("QUOTA_CHECK", ["q:base=k"], [0, "unused", 5, 60_000]), [1, 0, 4, 0]);
check("the window still holds exactly one charge", zcard("q:base=k"), 1);
check("check refuses once the limit is reached", (() => {
  for (let i = 0; i < 4; i++) evaluate("QUOTA", ["q:base=k"], [0, `c${i}`, 5, 60_000]);
  return evaluate("QUOTA_CHECK", ["q:base=k"], [0, "unused", 5, 60_000]);
})(), [0, 1, 0, 0]);

// --- S7: the window boundary matches the in-process limiter ---------------
// InProcessRateLimiter drops a timestamp when `now - ts >= windowMs`, so an
// entry exactly one window old is out. The shim and both scripts must agree, or
// a limit has a different edge in shared mode than in single-host mode.
console.log("S7: the window boundary matches the in-process limiter");
reset();
evaluate("QUOTA", ["q:base=k"], [0, "a", 1, 60_000]);
check("one millisecond short of the window: still refused", evaluate("QUOTA_CHECK", ["q:base=k"], [59_999, "u", 1, 60_000]), [0, 1, 0, 0]);
check("exactly one window old: aged out", evaluate("QUOTA_CHECK", ["q:base=k"], [60_000, "u", 1, 60_000]), [1, 0, 1, 0]);

// --- S8: the lock scripts are owner-checked -------------------------------
console.log("S8: release and renew only act for the current owner");
reset();
setKey("remembra:lock:k", "owner-a");
check("the owner can release its own lease", evaluate("RELEASE", ["remembra:lock:k"], ["owner-a"]), [1]);
setKey("remembra:lock:k", "owner-b");
check("a peer cannot release someone else's lease", evaluate("RELEASE", ["remembra:lock:k"], ["owner-a"]), [0]);
check("and the lease survives the attempt", keyExists("remembra:lock:k"), true);
check("the owner can renew its own lease", evaluate("RENEW", ["remembra:lock:k"], ["owner-b", 30_000]), [1]);
check("a peer cannot extend someone else's lease", evaluate("RENEW", ["remembra:lock:k"], ["owner-a", 30_000]), [0]);
check("releasing a key nobody holds is a no-op", evaluate("RELEASE", ["remembra:lock:absent"], ["owner-a"]), [0]);

console.log(`\n${checks - failures}/${checks} Lua checks passed`);
process.exit(failures === 0 ? 0 : 1);
