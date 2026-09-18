#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MODEL_URL =
  "https://raw.githubusercontent.com/mosynthkey/beat_this_cpp/e9e609472980e3bd7d3d1b06b629464269b9a907/onnx/beat_this.onnx";
const MODEL_SHA256 =
  "c5c1466e08abdb03fdeb50668a06f244b787d564c212490482231a9cfbe9ccbd";
const MODEL_SIZE_BYTES = 83_077_778;
const MODEL_RELATIVE_PATH = "webui/assets/models/beat-this/beat_this.onnx";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const modelPath = join(projectRoot, MODEL_RELATIVE_PATH);

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) !== MODEL_SIZE_BYTES) {
    throw new Error(
      `Unexpected model size from ${url}: ${contentLength} bytes`,
    );
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(targetPath),
  );
}

async function ensureModel() {
  if (await fileExists(modelPath)) {
    const digest = await sha256File(modelPath);
    if (digest === MODEL_SHA256) {
      process.stdout.write(`OK: ${MODEL_RELATIVE_PATH} already present\n`);
      return;
    }
    process.stdout.write(
      `WARN: ${MODEL_RELATIVE_PATH} checksum mismatch; downloading replacement\n`,
    );
  }

  const tempPath = `${modelPath}.download`;
  await rm(tempPath, { force: true });
  await downloadFile(MODEL_URL, tempPath);

  const digest = await sha256File(tempPath);
  if (digest !== MODEL_SHA256) {
    await rm(tempPath, { force: true });
    throw new Error(
      `Downloaded Beat This model checksum mismatch: expected ${MODEL_SHA256}, got ${digest}`,
    );
  }

  await rename(tempPath, modelPath);
  process.stdout.write(`OK: Downloaded ${MODEL_RELATIVE_PATH}\n`);
}

ensureModel().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
