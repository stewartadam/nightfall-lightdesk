#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(
  new URL(
    "../crates/fixture-library/tests/gdtf-bench/manifest.json",
    import.meta.url,
  ),
);

/** Base URL of the GDTF Share public API. */
export const shareApi = "https://gdtf-share.com/apis/public";

/**
 * Returns the command-line usage text for the bench fetcher.
 */
function usage() {
  return `usage: pnpm run gdtf-bench:fetch

Downloads the curated GDTF bench archives listed in
crates/fixture-library/tests/gdtf-bench/manifest.json from GDTF Share into
NIGHTFALL_GDTF_BENCH_DIR, verifying each archive's pinned SHA-256.

Environment:
  NIGHTFALL_GDTF_BENCH_DIR  Directory the bench archives are stored in
  GDTF_SHARE_USER           GDTF Share account user name
  GDTF_SHARE_PASSWORD       GDTF Share account password

Archives already present with the pinned hash are kept, and no login happens
when every archive is present.
`;
}

/**
 * Lowercases a name and drops everything but letters and digits, so GDTF
 * Share list fields and the underscore-joined archive file names compare equal.
 */
export function normalizeName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Returns the lowercase hex SHA-256 of a buffer.
 */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Lists the GDTF Share revisions that may be a bench archive, most likely first.
 *
 * Archive file names follow GDTF Share's `Manufacturer@Fixture@Revision.gdtf`
 * download naming. Revisions of the same manufacturer and fixture are
 * candidates; the one whose revision text matches the file name is tried
 * first. The pinned hash, not the name, decides which candidate is the archive.
 */
export function candidateRevisions(archive, list) {
  const [manufacturer, fixture, ...revision] = archive.file
    .replace(/\.gdtf$/i, "")
    .split("@");
  const wantedRevision = normalizeName(revision.join("@"));
  return list
    .filter(
      (entry) =>
        normalizeName(entry.manufacturer) === normalizeName(manufacturer) &&
        normalizeName(entry.fixture) === normalizeName(fixture),
    )
    .sort(
      (a, b) =>
        Number(normalizeName(b.revision) === wantedRevision) -
        Number(normalizeName(a.revision) === wantedRevision),
    );
}

/**
 * Returns the `name=value` pairs of every `Set-Cookie` header on a response.
 */
function sessionCookies(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/**
 * Logs in to GDTF Share and returns a client for listing and downloading revisions.
 *
 * The API keeps the login in a session cookie, which is replayed on every
 * later request. `fetchImpl` is injectable for tests.
 */
export async function loginToShare(user, password, fetchImpl = fetch) {
  const response = await fetchImpl(`${shareApi}/login.php`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.result !== true) {
    throw new Error(
      `GDTF Share login failed: ${body.error ?? `HTTP ${response.status}`}`,
    );
  }
  const cookie = sessionCookies(response);
  const headers = cookie ? { Cookie: cookie } : {};

  return {
    /** Lists every revision on GDTF Share. */
    async list() {
      const listResponse = await fetchImpl(`${shareApi}/getList.php`, {
        headers,
      });
      const listBody = await listResponse.json().catch(() => ({}));
      const list = Array.isArray(listBody) ? listBody : listBody.list;
      if (!listResponse.ok || !Array.isArray(list)) {
        throw new Error(
          `GDTF Share list failed: ${listBody.error ?? `HTTP ${listResponse.status}`}`,
        );
      }
      const missing = ["rid", "manufacturer", "fixture", "revision"].filter(
        (field) => list.length > 0 && !(field in list[0]),
      );
      if (missing.length > 0) {
        throw new Error(
          `GDTF Share list entries lack ${missing.join(", ")}; fields are ${Object.keys(list[0]).join(", ")}`,
        );
      }
      return list;
    },

    /** Downloads one revision's archive bytes. */
    async download(rid) {
      const downloadResponse = await fetchImpl(
        `${shareApi}/downloadFile.php?rid=${encodeURIComponent(rid)}`,
        { headers },
      );
      if (!downloadResponse.ok) {
        throw new Error(
          `GDTF Share download of revision ${rid} failed: HTTP ${downloadResponse.status}`,
        );
      }
      return Buffer.from(await downloadResponse.arrayBuffer());
    },
  };
}

/**
 * Returns the manifest archives missing from the bench directory.
 *
 * A present archive whose hash differs from the manifest fails instead of
 * being replaced, so a locally edited or re-pinned archive is never silently
 * overwritten.
 */
export function missingArchives(manifest, dir) {
  const missing = [];
  for (const archive of manifest.archives) {
    const path = join(dir, archive.file);
    if (!existsSync(path)) {
      missing.push(archive);
      continue;
    }
    const digest = sha256(readFileSync(path));
    if (digest !== archive.sha256) {
      throw new Error(
        `${archive.id}: ${path} has hash ${digest}, manifest pins ${archive.sha256}; remove it to fetch the pinned revision`,
      );
    }
  }
  return missing;
}

/**
 * Describes why no GDTF Share revision matched an archive: either no fixture
 * of that manufacturer and name is listed, or every listed revision was
 * downloaded and hashed differently.
 */
export function unmatchedReason(archive, candidates) {
  if (candidates.length === 0) {
    return `  ${archive.id}: GDTF Share lists no fixture matching ${archive.file}`;
  }
  const checked = candidates
    .map(
      (entry) =>
        `    rid ${entry.rid}: ${JSON.stringify(entry.revision)}${entry.lastModified ? ` (modified ${new Date(entry.lastModified * 1000).toISOString().slice(0, 10)})` : ""}`,
    )
    .join("\n");
  return `  ${archive.id}: ${candidates.length} revision(s) of ${archive.file} differ from the pinned hash:\n${checked}`;
}

/**
 * Downloads every missing bench archive into `dir` and returns the fetched ids.
 *
 * Each archive is matched to a GDTF Share revision by manufacturer and
 * fixture, then accepted only when its bytes hash to the pinned SHA-256.
 * Archives are written through a temporary file so an interrupted run never
 * leaves a partial archive under its final name. Fails after fetching the
 * rest, explaining per unmatched archive whether GDTF Share lists no such
 * fixture or which revisions were checked and found to differ.
 */
export async function fetchBench({ manifest, dir, login, log = () => {} }) {
  const missing = missingArchives(manifest, dir);
  if (missing.length === 0) {
    log("All bench archives are present.");
    return [];
  }

  const client = await login();
  const list = await client.list();
  await mkdir(dir, { recursive: true });

  const fetched = [];
  const unmatched = [];
  for (const archive of missing) {
    const candidates = candidateRevisions(archive, list);
    let bytes;
    for (const entry of candidates) {
      const candidate = await client.download(entry.rid);
      if (sha256(candidate) === archive.sha256) {
        bytes = candidate;
        break;
      }
    }
    if (!bytes) {
      unmatched.push(unmatchedReason(archive, candidates));
      continue;
    }
    const path = join(dir, archive.file);
    await writeFile(`${path}.partial`, bytes);
    await rename(`${path}.partial`, path);
    fetched.push(archive.id);
    log(`Fetched ${archive.id}: ${archive.file}`);
  }

  if (unmatched.length > 0) {
    throw new Error(
      `No GDTF Share revision matches the pinned hash for ${unmatched.length} archive(s). A pinned revision that was removed or re-uploaded must be replaced in the manifest, or the archive copied into the bench directory by hand.\n${unmatched.join("\n")}`,
    );
  }
  return fetched;
}

/**
 * Reads a required environment variable or fails naming it.
 */
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

/**
 * Runs the fetcher from the command line.
 */
async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (argv.length > 0) throw new Error(`unexpected argument: ${argv[0]}`);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  await fetchBench({
    manifest,
    dir: requireEnv("NIGHTFALL_GDTF_BENCH_DIR"),
    login: () =>
      loginToShare(
        requireEnv("GDTF_SHARE_USER"),
        requireEnv("GDTF_SHARE_PASSWORD"),
      ),
    log: (message) => process.stdout.write(`${message}\n`),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
