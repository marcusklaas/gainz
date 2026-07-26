// GitHub Contents API. Updates require the file's current SHA, so a concurrent
// write from another device returns 409 and the caller retries. See store.ts.
import type { Settings } from "./settings.js";

export interface RemoteFile {
  text: string;
  sha: string;
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function url(s: Settings, path: string): string {
  return `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${path}`;
}

function headers(s: Settings): HeadersInit {
  return {
    Authorization: `Bearer ${s.pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Null when the file does not exist yet. */
export async function getFile(s: Settings, path: string): Promise<RemoteFile | null> {
  const res = await fetch(`${url(s, path)}?ref=${encodeURIComponent(s.branch)}`, {
    headers: headers(s),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { content: string; sha: string };
  return { text: fromBase64(body.content), sha: body.sha };
}

/** Returns the new SHA. Throws with status 409 on a conflicting write. */
export async function putFile(
  s: Settings,
  path: string,
  text: string,
  sha: string | null,
  message: string,
): Promise<string> {
  const res = await fetch(url(s, path), {
    method: "PUT",
    headers: { ...headers(s), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: toBase64(text),
      branch: s.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    const err = new Error(`PUT ${path}: ${res.status} ${await res.text()}`) as Error & {
      status: number;
    };
    err.status = res.status;
    throw err;
  }
  const body = (await res.json()) as { content: { sha: string } };
  return body.content.sha;
}

/** Cheap credential check for the setup screen. */
export async function checkAccess(s: Settings): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${s.owner}/${s.repo}`, {
    headers: headers(s),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Cannot reach ${s.owner}/${s.repo}: ${res.status}`);
}
