/**
 * Line-based unified diff (audit Phase 8 — diff/history view).
 *
 * Zero-dependency LCS over lines producing standard unified format with 2
 * lines of context, so any client that renders `diff -u` output renders our
 * history view for free.
 *
 * Guard: the LCS table is O(n·m) — contents above the cell budget fall back
 * to a coarse whole-block diff instead of allocating hundreds of megabytes.
 */

const MAX_CELLS = 4_000_000;
const CONTEXT = 2;

interface Op {
  kind: "keep" | "add" | "remove";
  line: string;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "keep", line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      ops.push({ kind: "remove", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "remove", line: a[i++] });
  while (j < m) ops.push({ kind: "add", line: b[j++] });
  return ops;
}

/**
 * Unified diff of `prev` → `next`. Empty string when identical.
 * `fromLabel`/`toLabel` name the sides (defaults: previous/current).
 */
export function unifiedDiff(prev: string, next: string, fromLabel = "previous", toLabel = "current"): string {
  if (prev === next) return "";
  const a = prev.split("\n");
  const b = next.split("\n");

  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    // Coarse fallback: claim a full rewrite rather than allocating the table.
    return [
      `--- ${fromLabel}`,
      `+++ ${toLabel}`,
      `@@ -1,${a.length} +1,${b.length} @@ (diff omitted: content too large for line diff)`,
      ...a.map((l) => `-${l}`),
      ...b.map((l) => `+${l}`),
    ].join("\n");
  }

  const ops = lcsOps(a, b);
  const header = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let out = header.join("\n");

  // Group changed regions (with context) into hunks.
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].kind === "keep") {
      idx++;
      continue;
    }
    // Expand over the changed run.
    let end = idx;
    while (end < ops.length) {
      if (ops[end].kind !== "keep") {
        end++;
        continue;
      }
      // Peek: a keep run shorter than 2·context followed by more changes
      // belongs to the same hunk.
      let run = 0;
      let probe = end;
      while (probe < ops.length && ops[probe].kind === "keep") {
        run++;
        probe++;
      }
      if (probe < ops.length && run <= CONTEXT * 2) {
        end = probe; // small keep-gap: bridge it and keep consuming changes
        continue;
      }
      break;
    }
    const start = Math.max(0, idx - CONTEXT);
    const stop = Math.min(ops.length, end + CONTEXT);

    // Line numbers (1-based) for the hunk header.
    let aLine = 0;
    let bLine = 0;
    for (let k = 0; k < start; k++) {
      if (ops[k].kind !== "add") aLine++;
      if (ops[k].kind !== "remove") bLine++;
    }
    const aStart = aLine + 1;
    const bStart = bLine + 1;
    let aCount = 0;
    let bCount = 0;
    const hunk: string[] = [];
    for (let k = start; k < stop; k++) {
      const op = ops[k];
      if (op.kind === "keep") {
        hunk.push(` ${op.line}`);
        aCount++;
        bCount++;
      } else if (op.kind === "remove") {
        hunk.push(`-${op.line}`);
        aCount++;
      } else {
        hunk.push(`+${op.line}`);
        bCount++;
      }
    }
    out += `\n@@ -${aStart},${aCount} +${bStart},${bCount} @@\n${hunk.join("\n")}`;
    idx = stop;
  }
  return out + "\n";
}
