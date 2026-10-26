# CDS 670 · OS-DPI Student Issue Tracker

A small public support board for students using OS-DPI in their class projects.

**Student website (after GitHub Pages is enabled):** https://manohargolleru.github.io/CDS-670/

## What students see

- Report issues using a chosen display name. No GitHub account required.
- Browse, search and filter the 100 most recently updated GitHub Issues.
- Read instructor replies and see whether an issue is New, In progress, Needs info, Fixed or Closed.
- Attach up to 3 files (10 MB combined), including ZIPs, OS-DPI files and screenshots.
- Download supporting files from either the student page or the GitHub issue.
- Open an issue on GitHub for its permanent link.

All reports are public. Display names are unverified nicknames, not accounts or private identities. Students are not granted GitHub repository write access.

## Architecture

- `docs/`: static HTML, CSS and browser JavaScript hosted by GitHub Pages. No build step, database or npm dependencies.
- GitHub Issues in **this repo**: single source of truth for reports, comments and status labels. Students see GitHub data read-only through GitHub's public API.
- `worker/`: a small Cloudflare Worker that validates anonymous submissions, verifies Cloudflare Turnstile, rate-limits by IP and creates GitHub Issues using a server-side token.
- Small attachments are uploaded as GitHub release assets under the `student-attachments` tag and linked from the issue body. Files stay out of Git history; no additional storage subscription is needed.
- Instructors respond and change status through GitHub's normal Issues interface. The website refreshes on demand.

**Security:** Never put a GitHub token in `docs/`, `config.js`, commit history, or browser JavaScript. A static GitHub Pages site cannot anonymously create GitHub Issues safely without a server-side service.

## One-time setup for the instructor

### 1. Enable GitHub Pages

Go to [repository Settings → Pages](https://github.com/ManoharGolleru/CDS-670/settings/pages). Under **Build and deployment**, select **Deploy from a branch**, branch **main**, folder **/docs**. Save. The site will be served at https://manohargolleru.github.io/CDS-670/.

If Pages is disabled at the account or repository level, an administrator must enable it first. Publishing the repo files alone does not activate Pages.

### 2. Make a GitHub access token for the Worker

In GitHub, create a **fine-grained personal access token**, restricted to **only** `ManoharGolleru/CDS-670`, with **Issues: Read and write** and **Contents: Read and write**. Use an expiration date and rotate when necessary. Store it only as the Worker secret `GITHUB_TOKEN`. GitHub requires Contents write permission to upload release files; this permission also allows repository-content changes, so keep access restricted to this one repository.

To use a GitHub App installation token instead, add token rotation/issuance in the Worker first. Do not store expiring access tokens in static site files.

Before enabling attachments, create a public, mutable GitHub release tagged **`student-attachments`**, titled **Student report attachments**, targeting `main`. Mark it as not the latest release. The Worker looks up this fixed tag; it does not create releases. Do not delete the release or its files while reports still reference them.

### 3. Set up Cloudflare Turnstile

Create a free Turnstile site widget in Cloudflare. Add `manohargolleru.github.io` to its allowed hostnames. Copy its **site key** and **secret key** separately. The site key is public. The secret key is a Worker secret. The action name used here is `report-issue`.

### 4. Publish the Worker

From the `worker/` directory with Node.js installed:

```sh
npx wrangler login
npx wrangler deploy --secrets-file /absolute/path/outside-repo/worker-secrets.json
```

The owner-only JSON file must contain only `GITHUB_TOKEN` and `TURNSTILE_SECRET_KEY`. Keep it outside the checkout and delete this temporary deployment copy afterward. Uploading code and secrets together avoids a deployment missing its credentials. Keep the original credentials file private and outside the repository; do not upload the combined three-key file. Later secret changes can use `npx wrangler secret put KEY`.

Wrangler creates a Worker URL similar to `https://cds670-reports.YOUR-SUBDOMAIN.workers.dev`. The issue submission endpoint is `https://cds670-reports.YOUR-SUBDOMAIN.workers.dev/issues`. Keep the token and Turnstile secret private. The Worker is locked to origin `https://manohargolleru.github.io`. It accepts requests only for the `/issues` route. The Cloudflare rate limit limits 10 submissions per minute per IP per Cloudflare location, not a guarantee against distributed spam.

### 5. Connect the student page

Edit `docs/config.js` and replace its empty strings with your **public** Worker endpoint and Turnstile **site key**:

```js
window.CDS670_CONFIG = {
  submitEndpoint: "https://cds670-reports.YOUR-SUBDOMAIN.workers.dev/issues",
  turnstileSiteKey: "YOUR_PUBLIC_TURNSTILE_SITE_KEY"
};
```

Do not put secrets in this file. The page intentionally disables submissions until both settings are configured, while issue browsing keeps working.

### 6. Set up statuses

In [GitHub Issues labels](https://github.com/ManoharGolleru/CDS-670/labels), create these labels if missing (exact spelling):

| Label | Shown to students |
| --- | --- |
| `student-report` | Marks student submissions |
| `status: new` | New |
| `status: in progress` | In progress |
| `status: needs info` | Needs info |
| `status: fixed` | Fixed |

When investigating, replace the previous `status:` label with the next one. Comment directly on each GitHub Issue to answer students. Close the issue when fixed, and the website shows **Fixed**. Close with reason **Not planned** when the issue will not be addressed, and the website shows **Closed**. Reopening restores the label-based status.

Note: GitHub may ignore labels that have not been created by a repository maintainer. Reports still appear as **New** by default. The label names above matter for showing non-default states.

## Verification checklist

After deployment:
1. Open the GitHub Pages URL in a private browser window.
2. Confirm the issue list loads with no GitHub sign-in.
3. Submit a test issue with a nickname and Turnstile.
4. Check that the new issue appears under [GitHub Issues](https://github.com/ManoharGolleru/CDS-670/issues).
5. Add an instructor comment and change its status to `status: in progress`.
6. Refresh the student page and expand the issue to see the reply.
7. Close the test issue and confirm the status changes to **Fixed**.
8. Attach a small ZIP and a text file; verify both download byte-for-byte from the page and the GitHub issue.
9. Try an empty nickname, invalid Turnstile token, more than 3 files and more than 10 MB combined. Each should be rejected without creating an issue.

## Limitations

- The public GitHub API is subject to unauthenticated rate limits. Read failures show an error and a link to GitHub.
- The initial screen shows the 100 most recently updated issues, not a complete historical count for repositories with more than 100 reports.
- Display names are not identities. Students cannot edit or remove other students' reports through this page.
- Comments are instructor-managed on GitHub. No anonymous comment form is included.
- Turnstile and IP rate limiting reduce spam, but do not eliminate it.
- GitHub Pages and Cloudflare Workers are independent deployments. The repository write does not deploy the Worker automatically.

## Local verification

Worker tests use Node.js 22's built-in runner and dummy credentials. They never contact GitHub or Cloudflare:

```sh
node --test worker/test/*.test.mjs
```

The browser tests use Playwright and an installed Google Chrome. They intercept every browser request, run the real form and Worker handler, and mock Turnstile, GitHub and the rate-limit binding. They verify submission, nickname display, instructor replies, search, filters, mobile width, ZIP/text attachments, limits, upload retry and New → In progress → Fixed. This does not prove a Cloudflare deployment works.

```sh
node --test test/browser.test.mjs
```

If Playwright is supplied by a shared runtime, set `NODE_PATH` to that runtime's `node_modules` directory. The application itself still has no npm dependencies.

To preview the page without configuring submissions, serve only the public directory:

```sh
python3 -m http.server 8767 --bind 127.0.0.1 --directory docs
```

Open http://127.0.0.1:8767/. Reporting stays disabled until the real Worker endpoint and public site key are configured. Browsing contacts the public GitHub API. Keep the private credentials file outside this checkout, and never serve its parent directory. Real credentials are not needed for either test suite.

## Attachment behavior

Reports use browser-native multipart form data. Turnstile and rate limiting must pass before any release file is uploaded. The server enforces the 3-file and 10 MB combined limits, including requests without a Content-Length header. Files are never unpacked or executed by the Worker. Names are normalized to letters, numbers, dots, underscores and hyphens for safe GitHub links; each stored asset has a unique identifier to prevent collisions.

If an upload fails, the report is not created and the form keeps the selected files for retry. Uploaded assets are removed when a later upload fails or GitHub definitively rejects issue creation. If the issue-creation result is uncertain after a network failure, assets are retained so a possibly-created issue keeps working links. An instructor can inspect the attachment release to remove an unreferenced upload.

All attachments are public, just like the reports. Closing an issue keeps its files available. To remove a file, an instructor deletes the release asset and removes its link from the issue body. The student site only creates attachment links for the repository's own attachment release and renders other report text as plain text.
