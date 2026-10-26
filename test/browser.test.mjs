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
        method: request.method(), headers: request.headers(), body: request.postData() || undefined
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
  return { page, issues, comments, writes: () => writes };
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
