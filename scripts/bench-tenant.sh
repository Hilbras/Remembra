#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/remembra-tenant-bench-XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
query_count="${REMEMBRA_BENCH_QUERIES:-5}"
warmup_count="${REMEMBRA_BENCH_WARMUP:-2}"
IFS=',' read -r -a sizes <<< "${REMEMBRA_BENCH_SIZES:-10000,100000}"
for raw_size in "${sizes[@]}"; do
  size="${raw_size//[[:space:]]/}"
  root="$tmp/$size"
  mkdir -p "$root"
  started="$(date +%s%N)"
  node "$script_dir/seed-tenant-scale.mjs" "$root" "$size"
  seed_ms=$(( ($(date +%s%N) - started) / 1000000 ))
  printf '{"size":%s,"seed_ms":%s}\n' "$size" "$seed_ms" > "$tmp/$size.meta.json"
  for ((sample = -warmup_count; sample < query_count; sample++)); do
    if (( sample < 0 )); then
      target=$(( (warmup_count + sample) * size / (warmup_count + query_count) ))
      output="$tmp/$size.warmup-$sample.json"
    else
      target=$(( (sample + 1) * size / (query_count + 1) ))
      output="$tmp/$size.sample-$sample.json"
    fi
    REMEMBRA_BENCH_ROOT="$root" \
    REMEMBRA_BENCH_TARGET="$target" \
    node "$script_dir/bench-tenant-sample.mjs" > "$output"
  done
done
node "$script_dir/bench-tenant-aggregate.mjs" "$tmp"
