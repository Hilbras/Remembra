import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../job-queue.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("job queue bounds concurrency and preserves FIFO dispatch", async () => {
  const queue = new JobQueue({ concurrency: 1, maxQueue: 1, idGen: (() => {
    let n = 0;
    return () => `job-${++n}`;
  })() });
  const started: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.register<number>("work", async (value) => {
    started.push(value);
    await gate;
    return value * 2;
  });

  const first = queue.enqueue("work", 1);
  const second = queue.enqueue("work", 2);
  await tick();
  assert.deepEqual(started, [1]);
  assert.throws(() => queue.enqueue("work", 3), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "QUEUE_FULL");
    return true;
  });

  release();
  const results = await Promise.all([first.done, second.done]);
  assert.deepEqual(results.map((result) => result.state), ["completed", "completed"]);
  assert.deepEqual(results.map((result) => result.value), [2, 4]);
  assert.deepEqual(started, [1, 2]);
  await queue.shutdown();
});

test("job queue retries a bounded number of times", async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const queue = new JobQueue({
    maxAttempts: 3,
    retryDelayMs: 0,
    onError: (error) => errors.push(error),
  });
  queue.register("retry", async () => {
    attempts++;
    if (attempts < 3) throw new Error(`attempt ${attempts}`);
    return "ok";
  });

  const result = await queue.enqueue("retry", null).done;
  assert.equal(result.state, "completed");
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
  assert.deepEqual(errors, []);
  await queue.shutdown();
});

test("job queue reports terminal failure and queue shutdown", async () => {
  const queue = new JobQueue({ concurrency: 1, maxQueue: 1, maxAttempts: 1 });
  queue.register("fail", async () => {
    throw new Error("boom");
  });
  const failed = queue.enqueue("fail", null);
  const result = await failed.done;
  assert.equal(result.state, "failed");
  assert.match(String((result.error as Error).message), /boom/);

  queue.register("wait", async (_value, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const running = queue.enqueue("wait", null);
  await tick();
  const queued = queue.enqueue("wait", null);
  await queue.shutdown();
  assert.equal((await running.done).state, "cancelled");
  assert.equal((await queued.done).state, "cancelled");
  assert.throws(() => queue.enqueue("wait", null), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "QUEUE_CLOSED");
    return true;
  });
  assert.equal(queue.isClosed, true);
});

test("job queue rejects unknown job types and invalid limits", async () => {
  assert.throws(() => new JobQueue({ concurrency: 0 }), /concurrency/);
  assert.throws(() => new JobQueue({ maxQueue: -1 }), /maxQueue/);
  const queue = new JobQueue();
  assert.throws(() => queue.enqueue("missing", null), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "SERVICE_UNAVAILABLE");
    return true;
  });
  await queue.shutdown();
});
