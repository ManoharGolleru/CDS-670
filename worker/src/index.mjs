const GITHUB_ISSUES_URL = "https://api.github.com/repos/ManoharGolleru/CDS-670/issues";
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const CATEGORIES = new Set(["OS-DPI setup", "Design / code", "Testing", "Class assignment", "Other"]);

function send(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  });
}

function validSubmission(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const { displayName, title, category, description, website, turnstileToken } = data;
  if (typeof website !== "string" || website !== "") return false;
  if (typeof displayName !== "string" || !/^[\p{L}\p{N} _.-]{2,32}$/u.test(displayName) || displayName.trim().length < 2) return false;
  if (typeof title !== "string" || title.trim().length < 8 || title.length > 100 || /[\r\n]/.test(title)) return false;
  if (typeof description !== "string" || description.trim().length < 20 || description.length > 3000) return false;
  if (typeof category !== "string" || !CATEGORIES.has(category)) return false;
  if (typeof turnstileToken !== "string" || !turnstileToken.trim() || turnstileToken.length > 2048) return false;
  return true;
}

export async function handleRequest(request, env, fetcher = fetch) {
  const allowedOrigin = env.SITE_ORIGIN;
  if (!allowedOrigin || !/^https:\/\//.test(allowedOrigin)) {
    return new Response("Site origin is not configured", { status: 503 });
  }
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (url.pathname !== "/issues") return send({ error: "Not found" }, 404, allowedOrigin);
  if (origin !== allowedOrigin) return send({ error: "Origin not allowed" }, 403, allowedOrigin);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin"
      }
    });
  }
  if (request.method !== "POST") return send({ error: "Method not allowed" }, 405, allowedOrigin);

  if (!env.GITHUB_TOKEN || !env.TURNSTILE_SECRET_KEY || !env.SUBMISSIONS) {
    return send({ error: "Report service is not configured" }, 503, allowedOrigin);
  }
  if ((request.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return send({ error: "Expected JSON" }, 415, allowedOrigin);
  }
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 10000) return send({ error: "Report is too large" }, 413, allowedOrigin);

  let data;
  try {
    const text = await request.text();
    if (text.length > 10000) return send({ error: "Report is too large" }, 413, allowedOrigin);
    data = JSON.parse(text);
  } catch {
    return send({ error: "Invalid JSON" }, 400, allowedOrigin);
  }
  if (!validSubmission(data)) {
    return send({ error: "Check your name, title, description, and verification fields." }, 400, allowedOrigin);
  }

  let verification;
  try {
    const result = await fetcher(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: data.turnstileToken })
    });
    if (!result.ok) return send({ error: "Verification service is unavailable. Try again." }, 502, allowedOrigin);
    verification = await result.json();
  } catch {
    return send({ error: "Verification service is unavailable. Try again." }, 502, allowedOrigin);
  }
  const expectedHostname = new URL(allowedOrigin).hostname;
  if (verification?.success !== true || verification.hostname !== expectedHostname || verification.action !== "report-issue") {
    return send({ error: "Verification failed. Complete the check and try again." }, 403, allowedOrigin);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let limited;
  try {
    limited = await env.SUBMISSIONS.limit({ key: ip });
  } catch {
    return send({ error: "Report service is unavailable. Try again later." }, 503, allowedOrigin);
  }
  if (!limited.success) {
    return send({ error: "Too many reports from this network. Please retry in a minute." }, 429, allowedOrigin);
  }

  // A GitHub issue is written by the token owner. The student's name is a public,
  // self-chosen display name, not proof of identity.
  const body = [
    "<!-- cds670-student-report -->",
    "**Display name:** " + data.displayName.trim(),
    "**Area:** " + data.category,
    "",
    "### Description",
    data.description.trim().replace(/@/g, "@\u200b")
  ].join("\n");

  let issue;
  try {
    const response = await fetcher(GITHUB_ISSUES_URL, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + env.GITHUB_TOKEN,
        "Content-Type": "application/json",
        "User-Agent": "cds670-support-board",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({
        title: data.title.trim().replace(/@/g, "@\u200b"),
        body,
        labels: ["student-report", "status: new"]
      })
    });
    if (!response.ok) return send({ error: "GitHub did not accept this report. Please retry later." }, 502, allowedOrigin);
    issue = await response.json();
  } catch {
    return send({ error: "GitHub is unavailable right now. Please retry later." }, 502, allowedOrigin);
  }
  if (!Number.isInteger(issue?.number) || typeof issue.html_url !== "string") {
    return send({ error: "GitHub returned an unexpected response." }, 502, allowedOrigin);
  }
  return send({ number: issue.number, url: issue.html_url }, 201, allowedOrigin);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
