// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/** Exercise the packaged manifest and size report against known artifact bytes. */
test("browser packaging preserves integrity and reports only packaged byte sizes", () => {
  // Keep the fixture under the checkout so release metadata can resolve its commit.
  const root = mkdtempSync(join(projectRoot, ".browser-demo-test-"));
  /** Write one fixture file and create its containing directory. */
  function write(path, contents) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  /** Run a production packaging script against the disposable artifact. */
  function run(script) {
    return execFileSync(
      process.execPath,
      [join(projectRoot, "scripts", script)],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
  }
  try {
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    write("LICENSE", "Nightfall license");
    write(
      "webui/assets/browser-demo/nightfall-demo-click.LICENSE.txt",
      "Sample license",
    );
    write("webui/dist/index.html", "<html>demo</html>");
    write("webui/dist/assets/nightfall_browser_runtime_bg-test.wasm", wasm);
    write("webui/dist/assets/engine-runtime-worker-test.js", "worker");
    write(
      "webui/dist/nightfall-demo.nightfall-show/showfile.json",
      JSON.stringify({
        timelines: [{ audio_path: "sample.wav" }, { audio_path: "sample.wav" }],
      }),
    );
    write("webui/dist/nightfall-demo.nightfall-show/sample.wav", "audio");
    write(
      "webui/dist/notices/THIRD-PARTY-NOTICES.json",
      JSON.stringify({
        distribution: "Web — frontend and WebAssembly",
        entries: [{ name: "fixture" }],
      }),
    );
    write(
      "webui/dist/notices/THIRD-PARTY-NOTICES.txt",
      "Preline UI Fair Use License",
    );
    run("package-browser-demo-artifact.mjs");
    const manifest = JSON.parse(
      readFileSync(join(root, "webui/dist/browser-demo-manifest.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.files["assets/nightfall_browser_runtime_bg-test.wasm"],
      {
        bytes: wasm.length,
        sha256: createHash("sha256").update(wasm).digest("hex"),
        integrity: `sha384-${createHash("sha384").update(wasm).digest("base64")}`,
      },
    );
    assert.ok(manifest.files["notices/NIGHTFALL-LICENSE.txt"]);
    assert.ok(manifest.files["notices/SAMPLE-AUDIO-LICENSE.txt"]);
    const report = JSON.parse(run("report-browser-demo-size.mjs"));
    assert.deepEqual(report.total, { rawBytes: wasm.length + 6 + 5 });
    assert.deepEqual(report.groups.engineWasm, {
      files: ["nightfall_browser_runtime_bg-test.wasm"],
      rawBytes: wasm.length,
    });
    assert.equal(report.groups.sampleAudio.rawBytes, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
