"use strict";

const REPO = "ManoharGolleru/CDS-670";
const API = "https://api.github.com/repos/" + REPO;
const STAFF = new Set(["manohargolleru"]);
const config = window.CDS670_CONFIG || {};
const form = document.getElementById("report-form");
const nameInput = document.getElementById("display-name");
const feedback = document.getElementById("form-feedback");
const submitButton = document.getElementById("submit-button");
const list = document.getElementById("issue-list");
const message = document.getElementById("issue-message");
const search = document.getElementById("search");
const refresh = document.getElementById("refresh-button");

let issues = [];
let filter = "all";
let widgetId = null;
let verificationToken = "";
let expandedIssue = Number(new URLSearchParams(window.location.search).get("issue")) || null;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric"
  });
}

function statusFor(issue) {
  const labels = (issue.labels || []).map((label) =>
    String(typeof label === "string" ? label : label.name).toLowerCase());
  if (issue.state === "closed") {
    return issue.state_reason === "not_planned" ? "closed" : "fixed";
  }
  if (labels.includes("status: fixed")) return "fixed";
  if (labels.includes("status: in progress")) return "in-progress";
  if (labels.includes("status: needs info")) return "needs-info";
  return "new";
}

const statusNames = {
  "new": "New",
  "in-progress": "In progress",
  "needs-info": "Needs info",
  "fixed": "Fixed",
  "closed": "Closed"
};

function reportDetails(issue) {
  const raw = issue.body || "";
  const prefix = "<!-- cds670-student-report -->\n**Display name:** ";
  if (raw.startsWith(prefix)) {
    const match = /^<!-- cds670-student-report -->\n\*\*Display name:\*\* ([^\n]+)\n\*\*Area:\*\* ([^\n]+)\n\n### Description\n([\s\S]*)$/.exec(raw);
    if (match) return { name: match[1], category: match[2], description: match[3] };
  }
  return { name: issue.user?.login || "GitHub user", category: "", description: raw };
}

function githubLink(url, title) {
  const link = element("a", "github-link", title);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function updateCounts() {
  document.getElementById("stat-all").textContent = issues.length;
  document.getElementById("stat-open").textContent = issues.filter((issue) => issue.state === "open").length;
  document.getElementById("stat-progress").textContent = issues.filter((issue) => statusFor(issue) === "in-progress").length;
  document.getElementById("stat-fixed").textContent = issues.filter((issue) => statusFor(issue) === "fixed").length;
}

async function renderComments(issue, container) {
  container.replaceChildren(element("p", "issue-meta", "Loading replies…"));
  if (!issue.comments) {
    container.replaceChildren(element("p", "issue-meta", "No replies yet. Check back for an update."));
    return;
  }
  try {
    const response = await fetch(API + "/issues/" + issue.number + "/comments?per_page=100", {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!response.ok) throw new Error("Reply service unavailable");
    const comments = await response.json();
    container.replaceChildren();
    if (!comments.length) {
      container.append(element("p", "issue-meta", "No replies yet."));
      return;
    }
    for (const comment of comments) {
      const staff = STAFF.has((comment.user?.login || "").toLowerCase());
      const item = element("article", staff ? "comment staff" : "comment");
      const head = element("div", "comment-heading");
      head.append(element("strong", "", comment.user?.login || "GitHub user"));
      if (staff) head.append(element("span", "staff-tag", "Instructor"));
      head.append(element("span", "", "· " + formatDate(comment.created_at)));
      item.append(head, element("p", "comment-text", comment.body || ""));
      container.append(item);
    }
  } catch (error) {
    container.replaceChildren(element("p", "issue-meta", "Replies are unavailable right now."));
    container.append(githubLink(issue.html_url, "Read replies on GitHub ↗"));
  }
}

function makeIssue(issue) {
  const detail = reportDetails(issue);
  const status = statusFor(issue);
  const card = element("details", "issue-card");
  const summary = element("summary");
  const firstRow = element("div", "issue-row-top");
  firstRow.append(element("span", "issue-number", "#" + issue.number));
  firstRow.append(element("span", "status status-" + status, statusNames[status]));
  summary.append(firstRow, element("div", "issue-title", issue.title || "Untitled report"));
  summary.append(element("div", "issue-meta", "By " + detail.name + " · Updated " + formatDate(issue.updated_at)));
  const body = element("div", "issue-body");
  if (detail.category) {
    const group = element("div");
    group.append(element("span", "issue-category", detail.category));
    body.append(group);
  }
  body.append(element("div", "issue-detail-label", "Problem"));
  body.append(element("p", "issue-description", detail.description || "No description provided."));
  body.append(element("div", "issue-detail-label", "Instructor replies"));
  const comments = element("div", "comments");
  body.append(comments, githubLink(issue.html_url, "Open issue on GitHub ↗"));
  card.append(summary, body);
  let loaded = false;
  card.addEventListener("toggle", () => {
    if (card.open && !loaded) {
      loaded = true;
      renderComments(issue, comments);
    }
  });
  if (issue.number === expandedIssue) card.open = true;
  return card;
}

function renderIssues() {
  const term = search.value.trim().toLocaleLowerCase();
  const visible = issues.filter((issue) => {
    if (filter !== "all" && statusFor(issue) !== filter) return false;
    const detail = reportDetails(issue);
    return (issue.title + " " + detail.name + " " + detail.description + " " + detail.category)
      .toLocaleLowerCase().includes(term);
  });
  list.replaceChildren();
  if (!visible.length) {
    message.textContent = issues.length ?
      "No reports match this search or filter." :
      "No issues reported yet. Be the first to report one.";
    return;
  }
  message.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const issue of visible) fragment.append(makeIssue(issue));
  list.append(fragment);
}

async function loadIssues() {
  refresh.disabled = true;
  message.textContent = "Loading reports…";
  try {
    const response = await fetch(API + "/issues?state=all&sort=updated&direction=desc&per_page=100", {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!response.ok) throw new Error("GitHub returned " + response.status);
    issues = (await response.json()).filter((issue) => !issue.pull_request);
    updateCounts();
    renderIssues();
  } catch (error) {
    message.textContent = "Unable to load reports right now. Open GitHub Issues using the link above.";
    list.replaceChildren();
  } finally {
    refresh.disabled = false;
  }
}

function showFeedback(text, isError = false, url = "") {
  feedback.hidden = false;
  feedback.classList.toggle("error", isError);
  feedback.replaceChildren(document.createTextNode(text));
  if (url) {
    feedback.append(document.createTextNode(" "));
    feedback.append(githubLink(url, "View report ↗"));
  }
}

function clearToken() {
  verificationToken = "";
  if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
}

function setupSubmission() {
  const endpoint = config.submitEndpoint;
  const sitekey = config.turnstileSiteKey;
  if (!endpoint || !sitekey) {
    document.getElementById("setup-notice").hidden = false;
    submitButton.textContent = "Reporting setup pending";
    return;
  }
  if (!/^https:\/\/[a-z0-9.-]+\.workers\.dev\/issues$/i.test(endpoint)) {
    document.getElementById("setup-notice").hidden = false;
    showFeedback("The report service URL is misconfigured.", true);
    return;
  }
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.onload = () => {
    if (!window.turnstile) return showFeedback("Verification failed to load.", true);
    widgetId = window.turnstile.render("#turnstile-container", {
      sitekey,
      action: "report-issue",
      callback: (token) => { verificationToken = token; },
      "expired-callback": () => { verificationToken = ""; },
      "error-callback": () => { verificationToken = ""; }
    });
    submitButton.disabled = false;
  };
  script.onerror = () => showFeedback("Verification failed to load. Please refresh the page.", true);
  document.head.append(script);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  if (!verificationToken) {
    showFeedback("Please complete the verification before posting.", true);
    return;
  }
  const endpoint = config.submitEndpoint;
  const previousName = nameInput.value.trim();
  submitButton.disabled = true;
  submitButton.textContent = "Posting…";
  feedback.hidden = true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: previousName,
        title: document.getElementById("issue-title").value.trim(),
        category: document.getElementById("category").value,
        description: document.getElementById("description").value.trim(),
        website: document.getElementById("website").value,
        turnstileToken: verificationToken
      })
    });
    let result;
    try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) throw new Error(result.error || "We couldn't post your report. Please try again.");
    showFeedback("Report #" + result.number + " submitted successfully.", false, result.url);
    try { localStorage.setItem("cds670-name", previousName); } catch {}
    form.reset();
    nameInput.value = previousName;
    expandedIssue = result.number;
    await loadIssues();
  } catch (error) {
    showFeedback(error.message || "Submission failed. Please try again.", true);
  } finally {
    clearToken();
    submitButton.disabled = false;
    submitButton.textContent = "Post report →";
  }
});

for (const button of document.querySelectorAll(".filter")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    for (const other of document.querySelectorAll(".filter")) {
      const selected = other === button;
      other.classList.toggle("active", selected);
      other.setAttribute("aria-pressed", String(selected));
    }
    renderIssues();
  });
}

search.addEventListener("input", renderIssues);
refresh.addEventListener("click", loadIssues);
try { nameInput.value = localStorage.getItem("cds670-name") || ""; } catch {}
setupSubmission();
loadIssues();
