// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  candidateRevisions,
  fetchBench,
  loginToShare,
  sha256,
  shareApi,
} from "./fetch-gdtf-bench.mjs";

const sharpy = {
  id: "sharpy",
  file: "Clay_Paky@Sharpy@ClayPaky_Official_File_Fw_Ver_2_25_006.gdtf",
  sha256: sha256(Buffer.from("sharpy archive")),
};

const shareList = [
  {
    rid: 1,
    manufacturer: "Clay Paky",
    fixture: "Sharpy",
    revision: "Older revision",
  },
  {
    rid: 2,
    manufacturer: "Clay Paky",
    fixture: "Sharpy",
    revision: "ClayPaky Official File Fw Ver 2.25.006",
  },
  {
    rid: 3,
    manufacturer: "Clay Paky",
    fixture: "Sharpy Plus",
    revision: "ClayPaky Official File Fw Ver 2.25.006",
  },
];

/**
 * Returns a fake GDTF Share client serving `archives` by revision id and
 * recording each download.
 */
function fakeClient(archives) {
  const downloads = [];
  return {
    downloads,
    async list() {
      return shareList;
    },
    async download(rid) {
      downloads.push(rid);
      return Buffer.from(archives[rid] ?? "other archive");
    },
  };
}

/** Candidates share the manufacturer and fixture, with the named revision first. */
test("orders same-fixture revisions with the named revision first", () => {
  assert.deepEqual(
    candidateRevisions(sharpy, shareList).map((entry) => entry.rid),
    [2, 1],
  );
});

/** A missing archive is fetched from the revision whose bytes match the pinned hash. */
test("fetches the revision matching the pinned hash", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gdtf-bench-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = fakeClient({ 2: "sharpy archive" });

  const fetched = await fetchBench({
    manifest: { archives: [sharpy] },
    dir,
    login: async () => client,
  });

  assert.deepEqual(fetched, ["sharpy"]);
  assert.deepEqual(client.downloads, [2]);
  assert.equal(readFileSync(join(dir, sharpy.file), "utf8"), "sharpy archive");
  assert.deepEqual(readdirSync(dir), [sharpy.file]);
});

/** The hash, not the revision name, decides which revision is the pinned archive. */
test("falls back to other revisions when the named one does not match", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gdtf-bench-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = fakeClient({ 1: "sharpy archive" });

  await fetchBench({
    manifest: { archives: [sharpy] },
    dir,
    login: async () => client,
  });

  assert.deepEqual(client.downloads, [2, 1]);
  assert.ok(existsSync(join(dir, sharpy.file)));
});

/** A complete bench directory needs no credentials. */
test("does not log in when every archive is present", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gdtf-bench-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, sharpy.file), "sharpy archive");

  const fetched = await fetchBench({
    manifest: { archives: [sharpy] },
    dir,
    login: async () => assert.fail("logged in"),
  });

  assert.deepEqual(fetched, []);
});

/** A present archive with another hash is reported instead of overwritten. */
test("rejects a present archive whose hash differs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gdtf-bench-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, sharpy.file), "edited archive");

  await assert.rejects(
    fetchBench({
      manifest: { archives: [sharpy] },
      dir,
      login: async () => assert.fail("logged in"),
    }),
    /sharpy: .* remove it to fetch the pinned revision/,
  );
  assert.equal(readFileSync(join(dir, sharpy.file), "utf8"), "edited archive");
});

/** A pinned revision no longer on GDTF Share fails naming the archive. */
test("fails naming archives no revision matches", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gdtf-bench-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    fetchBench({
      manifest: { archives: [sharpy] },
      dir,
      login: async () => fakeClient({}),
    }),
    /pinned hash for: sharpy/,
  );
  assert.deepEqual(readdirSync(dir), []);
});

/** The login cookie is replayed on list and download requests. */
test("replays the session cookie from login", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, cookie: init.headers?.Cookie });
    if (url.endsWith("/login.php")) {
      assert.deepEqual(JSON.parse(init.body), { user: "u", password: "p" });
      return new Response(JSON.stringify({ result: true }), {
        headers: { "Set-Cookie": "PHPSESSID=abc; path=/; HttpOnly" },
      });
    }
    if (url.endsWith("/getList.php")) {
      return new Response(JSON.stringify({ result: true, list: shareList }));
    }
    return new Response("archive bytes");
  };

  const client = await loginToShare("u", "p", fetchImpl);
  assert.equal((await client.list()).length, 3);
  assert.equal((await client.download(2)).toString(), "archive bytes");
  assert.deepEqual(requests.slice(1), [
    { url: `${shareApi}/getList.php`, cookie: "PHPSESSID=abc" },
    { url: `${shareApi}/downloadFile.php?rid=2`, cookie: "PHPSESSID=abc" },
  ]);
});

/** Rejected credentials fail with the API's own error. */
test("reports a rejected login", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        result: false,
        error: "No valid user or password provided.",
      }),
    );
  await assert.rejects(
    loginToShare("u", "wrong", fetchImpl),
    /login failed: No valid user or password provided/,
  );
});
