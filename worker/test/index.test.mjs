import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.mjs";

const origin = "https://manohargolleru.github.io";
const payload = {
  displayName: "CDS670-Test", title: "Offline test report", category: "Testing",
  description: "Steps to reproduce this offline test report.", website: "",
  turnstileToken: "dummy-local-token"
};

function request(data = payload, options = {}) {
  const form = new FormData();
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) form.set(key, value);
  }
  return new Request("https://example.workers.dev/issues", {
    method: "POST", headers: { Origin: origin }, body: form, ...options
  });
}

function fixture({ verification = { success: true, hostname: new URL(origin).hostname, action: "report-issue" },
  issue = { number: 1, html_url: "https://github.com/ManoharGolleru/CDS-670/issues/1" },
  limited = false, failure = "" } = {}) {
  const calls = [];
  const env = {
    SITE_ORIGIN: origin, GITHUB_TOKEN: "dummy-github-secret", TURNSTILE_SECRET_KEY: "dummy-turnstile-secret",
    SUBMISSIONS: { async limit(input) {
      calls.push({ service: "limit", input });
      if (failure === "limit") throw new Error("private-provider-error");
      return { success: !limited };
    } }
  };
  async function fetcher(url, options) {
    const service = url.includes("siteverify") ? "verification" : "github";
    calls.push({ service, options });
    if (failure === service) throw new Error("private-provider-error");
    if (failure === service + "-http") return new Response("private-provider-error", { status: 500 });
    if (failure === service + "-json") return new Response("invalid-json");
    return Response.json(service === "verification" ? verification : issue);
  }
  return { env, calls, run: (req = request()) => handleRequest(req, env, fetcher) };
}

test("valid report creates exactly one issue after verification and rate limiting", async () => {
  const f = fixture();
  const response = await f.run(request({ ...payload, title: "Report @someone", description: payload.description + " @someone" }, {
    headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.1" }
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(f.calls.map(c => c.service), ["verification", "limit", "github"]);
  assert.deepEqual(f.calls[1].input, { key: "192.0.2.1" });
  const issue = JSON.parse(f.calls[2].options.body);
  assert.deepEqual(issue.labels, ["student-report", "status: new"]);
  assert.match(issue.body, /\*\*Display name:\*\* CDS670-Test/);
  assert.match(issue.body, /@\u200bsomeone/);
  assert.match(issue.title, /@\u200bsomeone/);
  assert.equal(f.calls[2].options.headers.Authorization, "Bearer dummy-github-secret");
  const body = await response.text();
  assert.doesNotMatch(body, /dummy-.*secret/);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

test("allowed preflight works without secrets", async () => {
  const response = await handleRequest(new Request("https://example.workers.dev/issues", {
    method: "OPTIONS", headers: { Origin: origin }
  }), { SITE_ORIGIN: origin }, () => assert.fail("network"));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

for (const badOrigin of ["https://evil.example", "null", ""]) {
  test("rejects disallowed origin: " + badOrigin, async () => {
    const f = fixture();
    const response = await f.run(request(payload, { headers: { Origin: badOrigin, "Content-Type": "application/json" } }));
    assert.equal(response.status, 403);
    assert.equal(f.calls.length, 0);
  });
}

for (const [field, value] of [
  ["displayName", ""], ["displayName", "  "], ["displayName", "x"], ["displayName", "Bad@name"],
  ["title", "short"], ["title", "        "], ["title", "bad\nline title"], ["title", "x".repeat(101)],
  ["description", " " .repeat(20)], ["description", "short"], ["description", "x".repeat(3001)],
  ["category", "Unknown"], ["website", "spam"], ["turnstileToken", ""],
  ["turnstileToken", "   "], ["turnstileToken", "x".repeat(2049)]
]) {
  test("rejects invalid " + field + ": " + JSON.stringify(value).slice(0, 35), async () => {
    const f = fixture();
    assert.equal((await f.run(request({ ...payload, [field]: value }))).status, 400);
    assert.equal(f.calls.length, 0);
  });
}

for (const value of [null, [], "text", {}]) {
  test("rejects invalid payload shape " + JSON.stringify(value), async () => {
    const f = fixture();
    assert.equal((await f.run(request(value))).status, 400);
    assert.equal(f.calls.length, 0);
  });
}

for (const contentType of ["text/plain", "application/json", "application/jsonp"]) {
  test("rejects content type " + contentType, async () => {
    const f = fixture();
    assert.equal((await f.run(request(payload, { headers: { Origin: origin, "Content-Type": contentType } }))).status, 415);
    assert.equal(f.calls.length, 0);
  });
}

test("rejects malformed form data", async () => {
  const f = fixture();
  assert.equal((await f.run(request(payload, { body: "broken", headers: {
    Origin: origin, "Content-Type": "multipart/form-data; boundary=fixture"
  } }))).status, 400);
  assert.equal(f.calls.length, 0);
});

test("rejects oversized declared requests before reading their body", async () => {
  const f = fixture();
  assert.equal((await f.run(request(payload, { headers: {
    Origin: origin, "Content-Type": "multipart/form-data; boundary=fixture", "Content-Length": String(11 * 1024 * 1024)
  } }))).status, 413);
  assert.equal(f.calls.length, 0);
});

test("rejects unsupported paths and methods", async () => {
  const f = fixture();
  assert.equal((await f.run(new Request("https://example.workers.dev/other", { headers: { Origin: origin } }))).status, 404);
  assert.equal((await f.run(request(payload, { method: "GET", body: undefined }))).status, 405);
  assert.equal(f.calls.length, 0);
});

for (const secret of ["GITHUB_TOKEN", "TURNSTILE_SECRET_KEY", "SUBMISSIONS"]) {
  test("fails closed without " + secret, async () => {
    const f = fixture();
    delete f.env[secret];
    assert.equal((await f.run()).status, 503);
    assert.equal(f.calls.length, 0);
  });
}

for (const verification of [null, {}, { success: false }, { success: true, hostname: "evil.example", action: "report-issue" },
  { success: true, hostname: new URL(origin).hostname, action: "wrong-action" }]) {
  test("rejects failed or malformed verification " + JSON.stringify(verification), async () => {
    const f = fixture({ verification });
    assert.equal((await f.run()).status, 403);
    assert.deepEqual(f.calls.map(c => c.service), ["verification"]);
  });
}

test("rate limit blocks issue creation", async () => {
  const f = fixture({ limited: true });
  assert.equal((await f.run()).status, 429);
  assert.deepEqual(f.calls.map(c => c.service), ["verification", "limit"]);
});

for (const failure of ["verification", "verification-http", "verification-json", "limit", "github", "github-http", "github-json"]) {
  test("handles service failure without leaking details: " + failure, async () => {
    const f = fixture({ failure });
    const response = await f.run();
    assert.equal(response.status, failure === "limit" ? 503 : 502);
    assert.doesNotMatch(await response.text(), /private-provider-error|dummy-.*secret/);
    if (!failure.startsWith("github")) assert.ok(!f.calls.some(c => c.service === "github"));
  });
}

for (const issue of [null, {}, { number: "1", html_url: "url" }]) {
  test("handles malformed GitHub response " + JSON.stringify(issue), async () => {
    assert.equal((await fixture({ issue }).run()).status, 502);
  });
}
