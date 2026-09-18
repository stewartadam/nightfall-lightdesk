// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  documentFor,
  frontendNotices,
  legalFiles,
  renderNotices,
  rustNotices,
  textHash,
} from "./distribution-notices.mjs";

/** Preserve nested native-library notices and referenced author credits without following symlinks. */
test("collects nested legal texts and authors", () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-notices-"));
  try {
    mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "LICENSE"), "main license");
    writeFileSync(join(root, "vendor/NOTICE"), "vendored attribution");
    writeFileSync(join(root, "vendor/AUTHORS"), "copyright holders");
    writeFileSync(join(root, "vendor/code.c"), "code");
    assert.deepEqual(
      legalFiles(root).map((entry) => entry.file),
      ["LICENSE", "vendor/AUTHORS", "vendor/NOTICE"],
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

/** Model cargo-about's package identity and license-to-crate association. */
function cargoReport(root, licenses) {
  const pkg = {
    name: "example",
    version: "1.0.0",
    id: "example@1.0.0",
    manifest_path: join(root, "Cargo.toml"),
  };
  return {
    crates: [{ package: pkg, license: "MIT OR Apache-2.0" }],
    licenses: licenses.map((license) => ({
      ...license,
      used_by: [{ crate: pkg, path: null }],
    })),
  };
}

/** Use upstream-harvested text without a local license and show the selected dual-license branch. */
test("Rust notices use cargo-about texts and selected licenses", () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-notices-"));
  try {
    writeFileSync(join(root, "NOTICE"), "additional attribution");
    const report = cargoReport(root, [
      {
        id: "MIT",
        source_path: "LICENSE-MIT",
        text: "Copyright upstream\nMIT terms",
      },
    ]);
    const [entry] = rustNotices(report);
    assert.equal(entry.license, "MIT");
    assert.match(entry.text, /Copyright upstream/);
    assert.match(entry.text, /additional attribution/);
    assert.throws(
      () => rustNotices({ ...report, licenses: [] }),
      /Missing cargo-about license/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

/** Preserve every required license while keeping notices scoped to the matching package identity. */
test("Rust notices retain AND licenses and exclude unrelated packages", () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-notices-"));
  try {
    const report = cargoReport(root, [
      { id: "MIT", source_path: "LICENSE-MIT", text: "MIT attribution" },
      {
        id: "BSD-3-Clause",
        source_path: "LICENSE-BSD",
        text: "BSD attribution",
      },
    ]);
    report.licenses.push({
      id: "ISC",
      text: "unrelated",
      used_by: [{ crate: { id: "different@1" } }],
    });
    const [entry] = rustNotices(report);
    assert.equal(entry.license, "BSD-3-Clause AND MIT");
    assert.match(entry.text, /MIT attribution/);
    assert.match(entry.text, /BSD attribution/);
    assert.doesNotMatch(entry.text, /unrelated/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

/** cargo-about reports base SPDX IDs separately from exception-bearing crate expressions. */
test("Rust notices preserve SPDX license exceptions", () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-notices-"));
  try {
    const report = cargoReport(root, [
      {
        id: "Apache-2.0",
        source_path: "LICENSE",
        text: "Apache terms and LLVM exception",
      },
    ]);
    report.crates[0].license = "Apache-2.0 WITH LLVM-exception";
    assert.equal(
      rustNotices(report)[0].license,
      "Apache-2.0 WITH LLVM-exception",
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

/** Recover originals only for synthesized copyright placeholders, and fail if none are available. */
test("Rust placeholder attribution uses local originals or fails", () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-notices-"));
  try {
    const report = cargoReport(root, [
      {
        id: "MIT",
        source_path: null,
        text: "Copyright <year> <copyright holders>",
      },
    ]);
    assert.throws(() => rustNotices(report), /Missing attribution/);
    writeFileSync(join(root, "LICENSE"), "Copyright actual authors\nMIT terms");
    const [entry] = rustNotices(report);
    assert.match(entry.text, /Copyright actual authors/);
    assert.doesNotMatch(entry.text, /<copyright holders>/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

/** Preserve the entire custom Preline license and original artwork credit in both output formats. */
test("distribution contains full Preline terms and upstream artwork copyright", () => {
  const pkg = JSON.parse(
    readFileSync(
      new URL("../node_modules/preline/package.json", import.meta.url),
      "utf8",
    ),
  );
  const document = documentFor(
    "Test distribution",
    frontendNotices([{ name: "preline", version: pkg.version }]),
  );
  const text = renderNotices(document);
  assert.match(text, /Preline UI Fair Use License/);
  assert.match(text, /Redistributions must include this Fair Use License/);
  assert.match(text, /https:\/\/github.com\/htmlstreamofficial\/preline/);
  assert.match(text, /Copyright \(c\) 2023 Phosphor Icons/);
  assert.ok(
    text.includes(
      readFileSync(
        new URL("../webui/assets/models/beat-this/NOTICE.md", import.meta.url),
        "utf8",
      ).trim(),
    ),
  );
});

/** Normalize Windows checkouts when verifying pinned legal texts. */
test("notice hashes are independent of checkout line endings", () => {
  assert.equal(textHash("one\ntwo\n"), textHash("one\r\ntwo\r\n"));
});

/** Fail rather than silently choosing between inconsistent inventories of one dependency. */
test("conflicting inventories cannot overwrite each other", () => {
  const entry = {
    name: "dependency",
    version: "1",
    license: "MIT",
    source: "https://example.com",
    text: "first",
  };
  assert.throws(
    () => documentFor("test", [entry, { ...entry, text: "second" }]),
    /Conflicting notices/,
  );
});
