import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { handleRequest } from "../worker/src/index.mjs";

// Use an installed Playwright (or the desktop's bundled copy through NODE_PATH).
const { chromium } = createRequire(import.meta.url)("playwright");
const origin = "https://manohargolleru.github.io";
const home = origin + "/CDS-670/";
const endpoint = "https://cds670-local-test.example.workers.dev/issues";
const api = "https://api.github.com/repos/ManoharGolleru/CDS-670";

async function harness(t, configured = true) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const issues = [];
  const comments = [];
  const errors = [];
  const unexpectedRequests = [];
  const assets = [];
  const state = { rejectUploads: false };
  let writes = 0;
  page.on("pageerror", error => errors.push(error.message));
  const env = {
    SITE_ORIGIN: origin, GITHUB_TOKEN: "dummy-github-secret", TURNSTILE_SECRET_KEY: "dummy-turnstile-secret",
    SUBMISSIONS: { limit: async () => ({ success: true }) }
  };
  const upstream = async (url, options) => {
    if (url.includes("siteverify")) {
      const input = JSON.parse(options.body);
      assert.equal(input.secret, "dummy-turnstile-secret");
      return Response.json({ success: input.response === "dummy-widget-token", hostname: new URL(origin).hostname, action: "report-issue" });
    }
    if (url.endsWith("/releases/tags/student-attachments")) {
      return Response.json({ id: 42, upload_url: "https://uploads.github.com/repos/ManoharGolleru/CDS-670/releases/42/assets{?name,label}" });
    }
    if (url.startsWith("https://uploads.github.com/")) {
      if (state.rejectUploads) return new Response("provider failure", { status: 403 });
      const name = new URL(url).searchParams.get("name");
      const bytes = new Uint8Array(await options.body.arrayBuffer());
      const asset = { id: assets.length + 1, state: "uploaded", size: bytes.length,
        browser_download_url: "https://github.com/ManoharGolleru/CDS-670/releases/download/student-attachments/" + name };
      assets.push({ ...asset, bytes });
      return Response.json(asset, { status: 201 });
    }
    assert.equal(url, api + "/issues");
    writes++;
    const input = JSON.parse(options.body);
    const issue = { ...input, number: writes, html_url: api.replace("api.github.com/repos", "github.com") + "/issues/" + writes,
      user: { login: "ManoharGolleru" }, state: "open", comments: 0, updated_at: "2026-10-26T12:00:00Z" };
    issues.push(issue);
    return Response.json(issue, { status: 201 });
  };
  // Every browser request is intercepted. No real credentials or services are used.
  await context.route("**/*", async route => {
    const request = route.request();
    const url = request.url();
    if (url === endpoint) {
      const response = await handleRequest(new Request(url, {
        method: request.method(), headers: request.headers(), body: request.postDataBuffer() || undefined
      }), env, upstream);
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (url.startsWith(api + "/issues?")) return route.fulfill({ json: issues });
    if (url.startsWith(api + "/issues/1/comments?")) return route.fulfill({ json: comments });
    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js")) {
      return route.fulfill({ contentType: "text/javascript", body: `
        window.turnstile = {
          render(selector, options) {
            window.testVerification = options;
            document.querySelector(selector).textContent = 'Offline verification fixture';
            options.callback('dummy-widget-token');
            return 'fixture-widget';
          },
          reset() { window.testVerification.callback('dummy-widget-token'); }
        };` });
    }
    if (url.startsWith(home)) {
      const pathname = new URL(url).pathname.slice("/CDS-670/".length) || "index.html";
      if (["index.html", "app.js", "styles.css", "config.js"].includes(pathname)) {
        const contentType = pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html";
        const body = pathname === "config.js"
          ? `window.CDS670_CONFIG = ${JSON.stringify(configured
            ? { submitEndpoint: endpoint, turnstileSiteKey: "dummy-local-sitekey" }
            : { submitEndpoint: "", turnstileSiteKey: "" })};`
          : await readFile(new URL("../docs/" + pathname, import.meta.url), "utf8");
        return route.fulfill({ contentType, body });
      }
    }
    unexpectedRequests.push(url);
    return route.abort();
  });
  t.after(() => {
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
  });
  await page.goto(home);
  await page.getByText("No issues reported yet. Be the first to report one.").waitFor();
  return { page, issues, comments, assets, state, writes: () => writes };
}

test("offline browser: submission, nickname, reply, search, filters and status lifecycle", async t => {
  const h = await harness(t);
  const { page, issues, comments } = h;
  await page.locator("#display-name").fill("CDS670-Test");
  await page.locator("#issue-title").fill("Browser test report");
  await page.locator("#category").selectOption("Testing");
  await page.locator("#description").fill("Open a design, then observe the reported behavior.");
  await page.getByRole("button", { name: "Post report" }).click();
  await page.getByText("Report #1 submitted successfully.").waitFor();
  assert.equal(h.writes(), 1);
  await page.locator(".issue-card[open] .issue-meta").first().waitFor();
  assert.match(await page.locator(".issue-card").innerText(), /By CDS670-Test/);
  assert.equal(await page.locator(".status").innerText(), "New");
  assert.equal(await page.locator("#stat-all").innerText(), "1");
  assert.equal(await page.locator("#display-name").inputValue(), "CDS670-Test");
  assert.equal(await page.evaluate(() => localStorage.getItem("cds670-name")), "CDS670-Test");

  comments.push({ user: { login: "ManoharGolleru" }, body: "Instructor test reply.", created_at: "2026-10-26T12:00:00Z" });
  issues[0].comments = 1;
  issues[0].labels = ["student-report", "status: in progress"];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Instructor test reply.").waitFor();
  assert.equal(await page.locator(".status").innerText(), "In progress");
  assert.equal(await page.locator(".staff-tag").textContent(), "Instructor");
  await page.getByRole("button", { name: "New", exact: true }).click();
  assert.equal(await page.locator(".issue-card").count(), 0);
  await page.getByRole("button", { name: "In progress", exact: true }).click();
  assert.equal(await page.locator(".issue-card").count(), 1);
  await page.locator("#search").fill("no-match");
  assert.equal(await page.locator(".issue-card").count(), 0);
  await page.locator("#search").fill("CDS670-Test");
  assert.equal(await page.locator(".issue-card").count(), 1);
  await page.getByRole("button", { name: "All", exact: true }).click();
  issues[0].state = "closed";
  issues[0].state_reason = "completed";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator(".status-fixed").waitFor();
  assert.equal(await page.locator(".status").innerText(), "Fixed");
  assert.equal(await page.locator("#stat-fixed").innerText(), "1");
  assert.equal(h.writes(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

test("offline browser: unconfigured reporting stays disabled and browsing works", async t => {
  const { page, writes } = await harness(t, false);
  assert.equal(await page.locator("#setup-notice").isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "Reporting setup pending" }).isDisabled(), true);
  assert.equal(writes(), 0);
});

async function fillReport(page) {
  await page.locator("#display-name").fill("CDS670-Test");
  await page.locator("#issue-title").fill("Attachment browser test");
  await page.locator("#description").fill("This report includes public attachment test fixtures.");
}

test("offline browser: attach ZIP and text, remove a file, and show download links", async t => {
  const { page, assets, writes } = await harness(t);
  await fillReport(page);
  const zip = await readFile(new URL("fixtures/attachment.zip", import.meta.url));
  const text = await readFile(new URL("fixtures/attachment.txt", import.meta.url));
  await page.locator("#attachments").setInputFiles([
    { name: "attachment.zip", mimeType: "application/zip", buffer: zip },
    { name: "attachment.txt", mimeType: "text/plain", buffer: text },
    { name: "remove.txt", mimeType: "text/plain", buffer: Buffer.from("remove this fixture") }
  ]);
  assert.equal(await page.locator("#selected-files li").count(), 3);
  await page.getByRole("button", { name: "Remove remove.txt", exact: true }).click();
  assert.equal(await page.locator("#selected-files li").count(), 2);
  await page.getByRole("button", { name: "Post report" }).click();
  await page.getByText("Report #1 submitted successfully.").waitFor();
  assert.equal(writes(), 1);
  assert.equal(assets.length, 2);
  assert.deepEqual(assets[0].bytes, new Uint8Array(zip));
  assert.deepEqual(assets[1].bytes, new Uint8Array(text));
  const link = page.getByRole("link", { name: "Download attachment.zip", exact: true });
  await link.waitFor();
  assert.match(await link.getAttribute("href"), /^https:\/\/github\.com\/ManoharGolleru\/CDS-670\/releases\/download\/student-attachments\//);
  assert.equal(await page.getByRole("link", { name: "Download attachment.txt", exact: true }).count(), 1);
  assert.equal(await page.locator("#selected-files li").count(), 0);
  assert.doesNotMatch(await page.locator(".issue-description").innerText(), /cds670-attachments|### Attachments/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

test("offline browser: upload failure keeps files and fields available for retry", async t => {
  const { page, state, writes } = await harness(t);
  state.rejectUploads = true;
  await fillReport(page);
  await page.locator("#attachments").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("public fixture") });
  await page.getByRole("button", { name: "Post report" }).click();
  await page.getByText("We couldn't upload the attachments. Your report has not been posted. Please retry later.", { exact: true }).waitFor();
  assert.equal(writes(), 0);
  assert.equal(await page.locator("#selected-files li").count(), 1);
  assert.equal(await page.locator("#issue-title").inputValue(), "Attachment browser test");
  state.rejectUploads = false;
  await page.getByRole("button", { name: "Post report" }).click();
  await page.getByText("Report #1 submitted successfully.").waitFor();
  assert.equal(writes(), 1);
});

test("offline browser: count and combined-size limits reject files before submission", async t => {
  const { page, writes } = await harness(t);
  await page.locator("#attachments").setInputFiles(Array.from({ length: 4 }, (_, i) => ({
    name: "file" + i + ".txt", mimeType: "text/plain", buffer: Buffer.from("public fixture")
  })));
  await page.getByText("Attach up to 3 files per report.", { exact: true }).waitFor();
  assert.equal(await page.locator("#selected-files li").count(), 0);
  await page.locator("#attachments").setInputFiles([
    { name: "one.zip", mimeType: "application/zip", buffer: Buffer.alloc(6 * 1024 * 1024) },
    { name: "two.zip", mimeType: "application/zip", buffer: Buffer.alloc(5 * 1024 * 1024) }
  ]);
  await page.getByText("Attachments must total 10 MB or less.", { exact: true }).waitFor();
  assert.equal(await page.locator("#selected-files li").count(), 0);
  assert.equal(writes(), 0);
});

test("offline browser: untrusted attachment text never becomes an external link", async t => {
  const { page, issues } = await harness(t);
  issues.push({ number: 1, title: "Untrusted attachment text", state: "open", comments: 0,
    html_url: "https://github.com/ManoharGolleru/CDS-670/issues/1", user: { login: "ManoharGolleru" },
    body: "<!-- cds670-student-report -->\n**Display name:** CDS670-Test\n**Area:** Testing\n\n### Description\nA test of untrusted attachment text.\n\n<!-- cds670-attachments -->\n### Attachments\n- [file.zip](https://evil.example/file.zip)" });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Untrusted attachment text", { exact: true }).click();
  assert.equal(await page.locator('a[href*="evil.example"]').count(), 0);
  assert.match(await page.locator(".issue-description").innerText(), /https:\/\/evil.example/);
});
