export const MAX_FILES = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;
const REPO_URL = "https://api.github.com/repos/ManoharGolleru/CDS-670";
const RELEASE_TAG = "student-attachments";
const DOWNLOAD_PREFIX = "https://github.com/ManoharGolleru/CDS-670/releases/download/" + RELEASE_TAG + "/";
const FIELDS = ["groupNumber", "title", "category", "description", "website", "turnstileToken"];

export async function readReport(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "multipart/form-data") {
    return { error: "Expected form data", status: 415 };
  }
  if (Number(request.headers.get("Content-Length")) > MAX_REQUEST_BYTES) {
    return { error: "Attachments must total 10 MB or less.", status: 413 };
  }
  if (!request.body) return { error: "Invalid form data", status: 400 };

  let bytes = 0;
  let tooLarge = false;
  const boundedBody = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        tooLarge = true;
        throw new Error("Request exceeds upload limit");
      }
      controller.enqueue(chunk);
    }
  }));
  let form;
  try {
    form = await new Response(boundedBody, { headers: { "Content-Type": contentType } }).formData();
  } catch {
    return { error: tooLarge ? "Attachments must total 10 MB or less." : "Invalid form data", status: tooLarge ? 413 : 400 };
  }
  const data = {};
  for (const field of FIELDS) {
    const values = form.getAll(field);
    if (values.length !== 1 || typeof values[0] !== "string") return { error: "Invalid report fields", status: 400 };
    data[field] = values[0];
  }
  if ([...form.keys()].some(key => !FIELDS.includes(key) && key !== "attachments")) {
    return { error: "Unexpected report field", status: 400 };
  }
  const files = form.getAll("attachments");
  if (files.some(file => !(file instanceof File) || !file.name || file.name.length > 120 || /[\x00-\x1f\x7f]/.test(file.name))) {
    return { error: "Check the attachment filenames (120 characters maximum).", status: 400 };
  }
  if (files.length > MAX_FILES) return { error: "Attach up to 3 files per report.", status: 400 };
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) {
    return { error: "Attachments must total 10 MB or less.", status: 413 };
  }
  return { data, files };
}

function headers(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cds670-support-board"
  };
}

export async function deleteAttachments(attachments, token, fetcher) {
  await Promise.all(attachments.map(async attachment => {
    try {
      const response = await fetcher(REPO_URL + "/releases/assets/" + attachment.id, {
        method: "DELETE", headers: headers(token)
      });
      if (!response.ok && response.status !== 404) console.error("Could not clean up an unsubmitted attachment.");
    } catch {
      console.error("Could not clean up an unsubmitted attachment.");
    }
  }));
}

export async function uploadAttachments(files, token, fetcher) {
  if (!files.length) return [];
  const response = await fetcher(REPO_URL + "/releases/tags/" + RELEASE_TAG, { headers: headers(token) });
  if (!response.ok) throw new Error("Attachment release is unavailable");
  const release = await response.json();
  if (!Number.isSafeInteger(release?.id) || release.id <= 0) throw new Error("Invalid attachment release");
  const uploadUrl = "https://uploads.github.com/repos/ManoharGolleru/CDS-670/releases/" + release.id + "/assets";
  if (release.upload_url !== uploadUrl + "{?name,label}" || release.immutable) throw new Error("Invalid attachment release");

  const uploaded = [];
  try {
    for (const file of files) {
      // Unique, conservative names avoid collisions and GitHub filename rewriting.
      const name = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+|\.+$/g, "") || "attachment";
      const assetName = crypto.randomUUID() + "-" + name;
      const url = new URL(uploadUrl);
      url.searchParams.set("name", assetName);
      const result = await fetcher(url.href, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/octet-stream", "Content-Length": String(file.size) },
        body: file
      });
      if (!result.ok) throw new Error("Attachment upload failed");
      const asset = await result.json();
      if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) throw new Error("Invalid uploaded attachment");
      uploaded.push({ id: asset.id, name, url: asset.browser_download_url, size: file.size });
      if (asset.state !== "uploaded" || asset.size !== file.size || asset.browser_download_url !== DOWNLOAD_PREFIX + assetName) {
        throw new Error("Invalid uploaded attachment");
      }
    }
    return uploaded;
  } catch (error) {
    await deleteAttachments(uploaded, token, fetcher);
    throw error;
  }
}

export function attachmentMarkdown(attachments) {
  if (!attachments.length) return "";
  return "\n\n<!-- cds670-attachments -->\n### Attachments\n" + attachments.map(file =>
    "- [" + file.name + "](" + file.url + ")"
  ).join("\n");
}
