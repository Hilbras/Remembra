import { test } from "node:test";
import assert from "node:assert/strict";
import { SensitiveDataDetector } from "../sensitive-data.js";

test("sensitive-data: detects API key pattern", () => {
  const det = new SensitiveDataDetector("redact");
  const r = det.scan("my key is sk-abc123def456ghi789jkl012mno345pqr");
  assert.equal(r.detected, true);
  assert.ok(r.categories.includes("api_key"));
  assert.ok(!r.text.includes("sk-abc"));
});

test("sensitive-data: detects AWS key pattern", () => {
  const det = new SensitiveDataDetector("redact");
  const r = det.scan("AWS_KEY=AKIAIOSFODNN7EXAMPLE");
  assert.equal(r.detected, true);
  assert.ok(r.categories.includes("aws_key"));
});

test("sensitive-data: detects private key header", () => {
  const det = new SensitiveDataDetector("redact");
  const r = det.scan("-----BEGIN RSA PRIVATE KEY-----");
  assert.equal(r.detected, true);
  assert.ok(r.categories.includes("private_key"));
});

test("sensitive-data: no false positive on normal text", () => {
  const det = new SensitiveDataDetector("redact");
  const r = det.scan("The project deadline is in three weeks");
  assert.equal(r.detected, false);
  assert.equal(r.categories.length, 0);
});

test("sensitive-data: allow policy returns text unchanged", () => {
  const det = new SensitiveDataDetector("allow");
  const r = det.scan("my password is secret123");
  assert.equal(r.detected, false);
  assert.equal(r.text, "my password is secret123");
});

test("sensitive-data: reject policy flags but does not modify", () => {
  const det = new SensitiveDataDetector("reject");
  const r = det.scan("use token=abcdefghijklmnopqrstuvwxyz for auth");
  assert.equal(r.detected, true);
  assert.equal(r.action, "reject");
});

test("sensitive-data: quarantine policy sets quarantine flag", () => {
  const det = new SensitiveDataDetector("quarantine");
  const r = det.scan("password: hunter2");
  assert.equal(r.detected, true);
  assert.equal(r.quarantine, true);
  assert.equal(r.action, "quarantine");
});

test("sensitive-data: empty text is clean", () => {
  const det = new SensitiveDataDetector("redact");
  const r = det.scan("");
  assert.equal(r.detected, false);
});
