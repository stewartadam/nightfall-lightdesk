// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { noticesJson, noticesText } from "./distribution-notices.mjs";

const artifactDirectory = resolve("webui/dist");
const metadataFile = "browser-demo-build.json";
const manifestFile = "browser-demo-manifest.json";
const contentVersion = "nightfall-demo-v1";
const protocolVersion = "client-bridge-v1";

/** Read one Git value without invoking a shell. */
function readGitValue(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Return every regular artifact file using stable forward-slash paths. */
function artifactFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...artifactFiles(path, root));
    } else if (entry.isFile()) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

/** Compute raw byte size and deploy-time integrity for one file. */
function describeFile(path) {
  const bytes = readFileSync(path);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha384-${createHash("sha384").update(bytes).digest("base64")}`,
  };
}

/** Stage notices and write the immutable browser-demo release contract. */
function main() {
  if (!statSync(resolve(artifactDirectory, "index.html")).isFile()) {
    throw new Error("Build webui/dist before packaging the browser demo");
  }

  const noticesDirectory = resolve(artifactDirectory, "notices");
  const notices = JSON.parse(
    readFileSync(resolve(noticesDirectory, noticesJson), "utf8"),
  );
  if (
    notices.distribution !== "Web — frontend and WebAssembly" ||
    !notices.entries.length
  ) {
    throw new Error(
      "Rebuild the browser demo: web distribution notices are missing or belong to another target",
    );
  }
  if (
    !readFileSync(resolve(noticesDirectory, noticesText), "utf8").includes(
      "Preline UI Fair Use License",
    )
  ) {
    throw new Error("Browser distribution is missing the Preline terms");
  }
  mkdirSync(noticesDirectory, { recursive: true });
  copyFileSync("LICENSE", resolve(noticesDirectory, "NIGHTFALL-LICENSE.txt"));
  copyFileSync(
    "webui/assets/browser-demo/nightfall-demo-click.LICENSE.txt",
    resolve(noticesDirectory, "SAMPLE-AUDIO-LICENSE.txt"),
  );

  const applicationCommit = readGitValue(["rev-parse", "HEAD"]);
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  const builtAt = sourceDateEpoch
    ? new Date(Number(sourceDateEpoch) * 1_000).toISOString()
    : new Date().toISOString();
  const metadata = {
    artifactId: `${applicationCommit}-${contentVersion}`,
    applicationCommit,
    contentVersion,
    protocolVersion,
    builtAt,
    basePath: "/demo/app/",
    entrypoint: "/demo/app/index.html",
  };
  writeFileSync(
    resolve(artifactDirectory, metadataFile),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  const files = Object.fromEntries(
    artifactFiles(artifactDirectory)
      .filter((file) => file !== manifestFile)
      .map((file) => [file, describeFile(resolve(artifactDirectory, file))]),
  );
  const manifest = { metadata, files };
  writeFileSync(
    resolve(artifactDirectory, manifestFile),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `Packaged ${Object.keys(files).length} browser-demo files as ${metadata.artifactId}\n`,
  );
}

main();
