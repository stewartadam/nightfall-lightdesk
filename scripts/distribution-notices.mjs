// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const noticesDirectory = "notices";
export const noticesJson = "THIRD-PARTY-NOTICES.json";
export const noticesText = "THIRD-PARTY-NOTICES.txt";
const npmLicenses = new Set([
  "MIT",
  "Apache-2.0",
  "Apache-2.0 OR MIT",
  "MIT OR Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
]);

/** Read a UTF-8 file relative to the checkout, independent of the caller's cwd. */
function read(path) {
  return readFileSync(resolve(projectRoot, path), "utf8");
}

/** Hash reviewed inputs without depending on platform-specific line endings. */
export function textHash(text) {
  return createHash("sha256")
    .update(text.replaceAll("\r\n", "\n"))
    .digest("hex");
}

/** Collect original legal texts, including notices for code vendored inside a dependency. */
export function legalFiles(directory, root = directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !["node_modules", ".git", "target"].includes(entry.name)
    ) {
      result.push(...legalFiles(path, root));
    } else if (
      entry.isFile() &&
      /^(licen[cs]e|copying|notice|copyright|authors)([._-]|$)/i.test(
        entry.name,
      )
    ) {
      const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n").trim();
      if (text)
        result.push({ file: relative(root, path).replaceAll("\\", "/"), text });
    }
  }
  return result.sort((a, b) => a.file.localeCompare(b.file, "en"));
}

/** Preserve complete upstream texts while avoiding repeated identical license blocks. */
function combineTexts(files) {
  const seen = new Set();
  return files
    .filter(({ text }) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    })
    .map(({ file, text }) => `${file}\n\n${text}`)
    .join("\n\n---\n\n");
}

/** Load pinned supplements that collectors cannot recover from published packages. */
function supplements() {
  return JSON.parse(read("config/notices/supplements.json"));
}

/** Read and verify a reviewed upstream text before adding it to a distribution. */
function supplementText(entry) {
  const text = read(`config/notices/${entry.file}`);
  if (textHash(text) !== entry.sha256)
    throw new Error(`Changed notice requires review: ${entry.file}`);
  return text.trim();
}

/** Resolve the installed copy corresponding to a bundled package, including nested versions. */
function npmDirectory(name, version) {
  const lock = JSON.parse(read("package-lock.json"));
  const path = Object.keys(lock.packages).find(
    (key) =>
      (key === `node_modules/${name}` ||
        key.endsWith(`/node_modules/${name}`)) &&
      lock.packages[key].version === version,
  );
  if (!path && version === "0.0.0") {
    const rootName = name.startsWith("@")
      ? name.split("/").slice(0, 2).join("/")
      : name.split("/")[0];
    const rootPath = `node_modules/${rootName}`;
    if (name !== rootName && lock.packages[rootPath])
      return resolve(projectRoot, rootPath);
  }
  if (!path)
    throw new Error(
      `Bundled package missing from lockfile: ${name}@${version}`,
    );
  return resolve(projectRoot, path);
}

/** Enrich Vite's bundle inventory with complete license, NOTICE, and AUTHORS files. */
export function frontendNotices(inventory, strict = true) {
  const reviewed = supplements();
  return inventory.map(({ name, version, identifier }) => {
    const directory = npmDirectory(name, version);
    const pkg = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    name = pkg.name;
    version = pkg.version;
    identifier = pkg.license;
    if (strict && name !== "preline" && !npmLicenses.has(identifier)) {
      throw new Error(
        `Review the license before shipping npm:${name}@${version}: ${identifier}`,
      );
    }
    const files = legalFiles(directory);
    const override = reviewed.find(
      (entry) => entry.package === `npm:${name}@${version}`,
    );
    if (override)
      files.push({ file: override.source, text: supplementText(override) });
    if (
      strict &&
      !override &&
      !files.some(({ file }) => /licen[cs]e|copying/i.test(file))
    ) {
      throw new Error(
        `Missing license text for npm:${name}@${version}; add a reviewed supplement`,
      );
    }
    if (name === "preline") {
      const approval = JSON.parse(read("config/notices/preline.json"));
      const license = readFileSync(join(directory, "LICENSE"), "utf8");
      if (
        version !== approval.version ||
        textHash(license) !== approval.sha256
      ) {
        throw new Error(
          "Preline license/version changed: review the custom terms before distribution",
        );
      }
    }
    const repository =
      typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    return {
      name,
      version,
      license: identifier ?? pkg.license ?? "Unspecified",
      source:
        repository ??
        pkg.homepage ??
        `https://www.npmjs.com/package/${name}/v/${version}`,
      text:
        combineTexts(files) ||
        "License text unavailable in the installed development package. Release builds reject missing licenses.",
    };
  });
}

/** Return a conservative development preview; release inventory comes exclusively from Vite. */
export function developmentNotices() {
  const lock = JSON.parse(read("package-lock.json"));
  const inventory = Object.entries(lock.packages)
    .filter(
      ([path, pkg]) =>
        path && !pkg.dev && existsSync(resolve(projectRoot, path)),
    )
    .map(([path, pkg]) => ({
      name: pkg.name ?? path.split("node_modules/").at(-1),
      version: pkg.version,
      identifier: pkg.license,
    }));
  return documentFor(
    "Development preview — installed production dependencies, including build tools. Release notices reflect bundled software.",
    frontendNotices(inventory, false),
  );
}

/** Adapt cargo-about's selected license texts, retaining ancillary and vendored notices. */
export function rustNotices(report) {
  const reviewed = supplements();
  return report.crates
    .filter(
      ({ package: pkg }) =>
        !relative(projectRoot, pkg.manifest_path)
          .replaceAll("\\", "/")
          .startsWith("crates/"),
    )
    .map(({ package: pkg, license: expression }) => {
      const selected = report.licenses.filter(({ used_by }) =>
        used_by.some(({ crate }) => crate.id === pkg.id),
      );
      if (!selected.length)
        throw new Error(
          `Missing cargo-about license for ${pkg.name}@${pkg.version}`,
        );
      const override = reviewed.find(
        (entry) => entry.package === `cargo:${pkg.name}@${pkg.version}`,
      );
      const originals = legalFiles(dirname(pkg.manifest_path));
      const exceptions = new Map(
        [
          ...expression.matchAll(/([A-Za-z0-9.+-]+) WITH ([A-Za-z0-9.+-]+)/g),
        ].map(([, id, exception]) => [id, `${id} WITH ${exception}`]),
      );
      const files = selected.flatMap(({ id, text, source_path }) => {
        if (!source_path && override)
          return [{ file: override.source, text: supplementText(override) }];
        if (!source_path && /<year>|<copyright holders>/.test(text)) {
          const licenses = originals.filter(({ file }) =>
            /^(licen[cs]e|copying)([._-]|$)/i.test(file),
          );
          if (licenses.length) return licenses;
          throw new Error(
            `Missing attribution in cargo-about license for ${pkg.name}@${pkg.version}; add a cargo-about clarification`,
          );
        }
        if (!text?.trim())
          throw new Error(
            `Empty cargo-about license for ${pkg.name}@${pkg.version}`,
          );
        return [{ file: id, text: text.trim() }];
      });
      // Preserve ancillary credits and embedded-library licenses beyond the selected crate license.
      files.push(
        ...originals.filter(
          ({ file }) =>
            file.includes("/") ||
            /^(notice|copyright|authors)([._-]|$)/i.test(file),
        ),
      );
      return {
        name: pkg.name,
        version: pkg.version,
        license: [
          ...new Set(selected.map(({ id }) => exceptions.get(id) ?? id)),
        ]
          .sort()
          .join(" AND "),
        source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`,
        text: combineTexts(files),
      };
    });
}

/** Run the pinned Cargo collector for the exact root, target and feature set being packaged. */
export function collectRust(
  manifest,
  target,
  features = [],
  run = execFileSync,
) {
  const version = run("cargo", ["about", "--version"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  if (version !== "cargo-about 0.8.4")
    throw new Error(
      "Install cargo-about 0.8.4: cargo install cargo-about --locked --version 0.8.4",
    );
  const args = [
    "about",
    "generate",
    "--manifest-path",
    manifest,
    "--target",
    target,
    "--locked",
    "--fail",
    "--format",
    "json",
  ];
  if (features.length)
    args.push("--no-default-features", "--features", features.join(","));
  const directory = mkdtempSync(join(tmpdir(), "nightfall-cargo-about-"));
  const reportPath = join(directory, "report.json");
  try {
    run("cargo", [...args, "--output-file", reportPath], {
      cwd: projectRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    return rustNotices(JSON.parse(readFileSync(reportPath, "utf8")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Merge component inventories and include the existing model notice verbatim. */
export function documentFor(distribution, entries) {
  const fixed = supplements()
    .filter((entry) => !entry.package)
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      license: entry.license,
      source: entry.source,
      text: supplementText(entry),
    }));
  const byPackage = new Map();
  for (const entry of [...entries, ...fixed]) {
    const key = `${entry.name}@${entry.version}`;
    if (byPackage.has(key) && byPackage.get(key).text !== entry.text)
      throw new Error(`Conflicting notices for ${key}`);
    byPackage.set(key, entry);
  }
  byPackage.set("Beat This", {
    name: "Beat This",
    version: "e9e609472980e3bd7d3d1b06b629464269b9a907",
    license: "MIT",
    source: "https://github.com/CPJKU/beat_this",
    text: read("webui/assets/models/beat-this/NOTICE.md").trim(),
  });
  return {
    schemaVersion: 1,
    distribution,
    entries: [...byPackage.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") ||
        a.version.localeCompare(b.version, "en"),
    ),
  };
}

/** Render a standalone, readable license file for offline use outside the application. */
export function renderNotices(document) {
  return `Nightfall third-party notices\n${document.distribution}\n\nRust registry links identify the corresponding unmodified source releases.\n\n${document.entries.map((entry) => `${entry.name} ${entry.version}\nLicense: ${entry.license}\nSource: ${entry.source}\n\n${entry.text}`).join("\n\n====================\n\n")}\n`;
}

/** Assemble the build's frontend and WASM notices, adding native dependencies for desktop packaging. */
export function packageNotices(outDir, target, embeddedDemo = false) {
  const directory = resolve(outDir, noticesDirectory);
  const frontend = JSON.parse(
    readFileSync(join(directory, "frontend.json"), "utf8"),
  );
  // CSS imports and Vite's injected module-preload runtime are not JS package modules.
  const supplemental = ["tailwindcss", "tw-animate-css", "vite"].map((name) => {
    const pkg = JSON.parse(read(`node_modules/${name}/package.json`));
    return { name, version: pkg.version, identifier: pkg.license };
  });
  const entries = frontendNotices([...frontend, ...supplemental]);
  for (const crate of embeddedDemo
    ? ["wasm-bridge", "browser-runtime"]
    : ["wasm-bridge"]) {
    entries.push(
      ...collectRust(`crates/${crate}/Cargo.toml`, "wasm32-unknown-unknown"),
    );
  }
  if (target) {
    const config = JSON.parse(read("crates/app/tauri.conf.json"));
    entries.push(
      ...collectRust("crates/app/Cargo.toml", target, config.build.features),
    );
    entries.push({
      name: "bevy_framepace (Nightfall fork)",
      version: "local",
      license: "MIT",
      source: "https://github.com/aevyrie/bevy_framepace",
      text: read("crates/framepace/src/lib.rs")
        .split("//!", 1)[0]
        .replace(/^\/\/ ?/gm, "")
        .trim(),
    });
  }
  const document = documentFor(
    target ? `Desktop — ${target}` : "Web — frontend and WebAssembly",
    entries,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, noticesJson),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  writeFileSync(join(directory, noticesText), renderNotices(document));
  writeFileSync(join(directory, "NIGHTFALL-LICENSE.txt"), read("LICENSE"));
  process.stdout.write(
    `Packaged ${document.entries.length} third-party notices (${document.distribution}).\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const target = process.argv[2] ?? process.env.TAURI_ENV_TARGET_TRIPLE;
  if (!target)
    throw new Error(
      "Desktop notices require a target triple argument or TAURI_ENV_TARGET_TRIPLE",
    );
  packageNotices(resolve(projectRoot, "webui/dist"), target);
}
