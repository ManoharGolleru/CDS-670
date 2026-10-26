import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { handleRequest } from "../src/index.mjs";
import { MAX_ATTACHMENT_BYTES, readReport, attachmentMarkdown } from "../src/attachments.mjs";

const origin = "https://manohargolleru.github.io";
const repo = "https://api.github.com/repos/ManoharGolleru/CDS-670";
const prefix = "https://github.com/ManoharGolleru/CDS-670/releases/download/student-attachments/";
const payload = { displayName: "CDS670-Test", title: "Attachment test report", category: "Testing",
  description: "A report with a small supporting attachment.", website: "", turnstileToken: "dummy-token" };

function request(files = [], change) {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) form.set(key, value);
  for (const file of files) form.append("attachments", file);
  change?.(form);
  return new Request("https://example.workers.dev/issues", { method: "POST", headers: { Origin: origin }, body: form });
}

function fixture({ fail = "", invalidAsset = false, verification = true, limited = false } = {}) {
  const calls = [];
  const uploaded = [];
  const env = { SITE_ORIGIN: origin, GITHUB_TOKEN: "dummy-github-secret", TURNSTILE_SECRET_KEY: "dummy-turnstile-secret",
    SUBMISSIONS: { limit: async () => ({ success: !limited }) } };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("siteverify")) return Response.json({ success: verification, hostname: new URL(origin).hostname, action: "report-issue" });
    if (url.endsWith("/releases/tags/student-attachments")) {
      if (fail === "release") return new Response("private-provider-error", { status: 404 });
      return Response.json({ id: 42, upload_url: "https://uploads.github.com/repos/ManoharGolleru/CDS-670/releases/42/assets{?name,label}" });
    }
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    if (url.startsWith("https://uploads.github.com/")) {
      if (fail === "upload" || (fail === "second-upload" && uploaded.length)) return new Response("private-provider-error", { status: 403 });
      const bytes = new Uint8Array(await options.body.arrayBuffer());
      const name = new URL(url).searchParams.get("name");
      const asset = { id: uploaded.length + 1, state: "uploaded", size: bytes.length, browser_download_url: prefix + name };
      uploaded.push({ asset, bytes });
      return Response.json(invalidAsset ? { ...asset, browser_download_url: "https://evil.example/file" } : asset, { status: 201 });
    }
    assert.equal(url, repo + "/issues");
    if (fail === "issue") return new Response("private-provider-error", { status: 422 });
    if (fail === "uncertain-issue") throw new Error("private-provider-error");
    return Response.json({ number: 2, html_url: "https://github.com/ManoharGolleru/CDS-670/issues/2" }, { status: 201 });
  };
  return { calls, uploaded, run: req => handleRequest(req, env, fetcher) };
}

const smallFile = name => new File(["public fixture"], name);

test("ZIP bytes survive multipart parsing and GitHub upload exactly", async () => {
  const bytes = await readFile(new URL("../../test/fixtures/attachment.zip", import.meta.url));
  const f = fixture();
  const response = await f.run(request([new File([bytes], "design.zip", { type: "application/zip" })]));
  assert.equal(response.status, 201);
  assert.deepEqual(f.uploaded[0].bytes, new Uint8Array(bytes));
  assert.match(f.calls[1].url, /releases\/tags\/student-attachments$/);
  assert.match(f.calls[2].url, /^https:\/\/uploads\.github\.com\//);
  const issue = JSON.parse(f.calls[3].options.body);
  assert.match(issue.body, /### Attachments\n- \[design.zip\]\(https:\/\/github.com\/ManoharGolleru\/CDS-670\/releases\/download\/student-attachments\//);
  assert.doesNotMatch(await response.text(), /dummy-.*secret/);
});

test("duplicate filenames get unique assets and safe Markdown", async () => {
  const f = fixture();
  assert.equal((await f.run(request([smallFile("design.zip"), smallFile("design.zip"), smallFile("[bad](@name).zip")]))).status, 201);
  assert.equal(new Set(f.uploaded.map(item => item.asset.browser_download_url)).size, 3);
  const body = JSON.parse(f.calls.at(-1).options.body).body;
  assert.match(body, /\[_bad___name_.zip\]/);
  assert.doesNotMatch(body, /@name/);
});

test("reports with no attachments do not call release APIs", async () => {
  const f = fixture();
  assert.equal((await f.run(request())).status, 201);
  assert.equal(f.calls.length, 2);
  assert.equal(attachmentMarkdown([]), "");
});

test("rejects unnamed attachment parts", async () => {
  const result = await readReport(request([new File([], "")]));
  assert.equal(result.status, 400);
});

for (const [name, change] of [
  ["duplicate text fields", form => form.append("displayName", "Other")],
  ["unexpected fields", form => form.set("extra", "value")],
  ["text instead of a file", form => form.append("attachments", "fake-file")],
  ["file instead of a text field", form => form.set("title", smallFile("title.txt"))]
]) {
  test("rejects " + name + " before contacting services", async () => {
    const f = fixture();
    assert.equal((await f.run(request([], change))).status, 400);
    assert.equal(f.calls.length, 0);
  });
}

test("rejects more than three files", async () => {
  const f = fixture();
  assert.equal((await f.run(request(Array.from({ length: 4 }, () => smallFile("file.txt"))))).status, 400);
  assert.equal(f.calls.length, 0);
});

test("enforces combined size, including requests without Content-Length", async () => {
  const f = fixture();
  const files = [new File([new Uint8Array(MAX_ATTACHMENT_BYTES / 2)], "one.zip"),
    new File([new Uint8Array(MAX_ATTACHMENT_BYTES / 2 + 1)], "two.zip")];
  const req = request(files);
  assert.equal(req.headers.has("Content-Length"), false);
  assert.equal((await f.run(req)).status, 413);
  assert.equal(f.calls.length, 0);
});

test("streaming request limit stops oversized bodies without Content-Length", async () => {
  const f = fixture();
  assert.equal((await f.run(request([new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 128 * 1024)], "large.zip")]))).status, 413);
  assert.equal(f.calls.length, 0);
});

test("accepts exactly ten megabytes", async () => {
  const result = await readReport(request([new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "boundary.zip")]));
  assert.equal(result.files[0].size, MAX_ATTACHMENT_BYTES);
});

test("rejects long filenames before uploading", async () => {
  const f = fixture();
  assert.equal((await f.run(request([smallFile("x".repeat(121))]))).status, 400);
  assert.equal(f.calls.length, 0);
});

for (const options of [{ verification: false }, { limited: true }]) {
  test("does not upload files without passing protection: " + JSON.stringify(options), async () => {
    const f = fixture(options);
    assert.equal((await f.run(request([smallFile("test.zip")]))).status, options.limited ? 429 : 403);
    assert.equal(f.uploaded.length, 0);
    assert.equal(f.calls.length, 1);
  });
}

for (const fail of ["release", "upload", "second-upload", "issue", "uncertain-issue"]) {
  test("handles attachment/report failure: " + fail, async () => {
    const f = fixture({ fail });
    const response = await f.run(request([smallFile("one.zip"), smallFile("two.txt")]));
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /private-provider-error|dummy-.*secret/);
    const deletes = f.calls.filter(call => call.options.method === "DELETE");
    assert.equal(deletes.length, fail === "second-upload" ? 1 : fail === "issue" ? 2 : 0);
    if (["release", "upload", "second-upload"].includes(fail)) assert.ok(!f.calls.some(call => call.url === repo + "/issues"));
  });
}

test("rejects unexpected asset URLs and cleans up the upload", async () => {
  const f = fixture({ invalidAsset: true });
  assert.equal((await f.run(request([smallFile("test.zip")]))).status, 502);
  assert.equal(f.calls.at(-1).options.method, "DELETE");
  assert.ok(!f.calls.some(call => call.url === repo + "/issues"));
});
