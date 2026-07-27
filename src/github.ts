// GitHub Contents API. Updates require the file's current SHA, so a concurrent
// write from another device returns 409 and the caller retries. See store.ts.
import type { Settings } from "./settings.js";

export interface RemoteFile {
  kind: "file";
  text: string;
  sha: string;
  /** Feed back to the next getFile to turn it into a conditional request. */
  etag: string | null;
}

/** The caller's etag still matches, so whatever it cached is current. */
export interface Unchanged {
  kind: "unchanged";
}

export interface Missing {
  kind: "missing";
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
  return `https://api.github.com/repos/${s.repo}/contents/${path}`;
}

function headers(s: Settings): HeadersInit {
  return {
    Authorization: `Bearer ${s.pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Passing the etag from a previous read makes this a conditional request. Old
 * month files never change, so on a normal start almost every one of these
 * comes back as a bodyless 304 — no JSON, no base64 to decode, and GitHub does
 * not charge it against the rate limit.
 */
export async function getFile(
  s: Settings,
  path: string,
  etag: string | null = null,
): Promise<RemoteFile | Unchanged | Missing> {
  const res = await fetch(`${url(s, path)}?ref=${encodeURIComponent(s.branch)}`, {
    headers: etag ? { ...headers(s), "If-None-Match": etag } : headers(s),
    cache: "no-store",
  });
  if (res.status === 304) return { kind: "unchanged" };
  if (res.status === 404) return { kind: "missing" };
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { content: string; sha: string };
  return { kind: "file", text: fromBase64(body.content), sha: body.sha, etag: res.headers.get("etag") };
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
  const res = await fetch(`https://api.github.com/repos/${s.repo}`, {
    headers: headers(s),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Cannot reach ${s.repo}: ${res.status}`);
}
