// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [
      name,
      parse(readFileSync(new URL(name, workflowDirectory), "utf8")),
    ]),
);
const release = workflows["release.yml"];
const unpack = release.jobs.sign.steps.find((step) => step.id === "app").run;
const inventory = release.jobs.publish.steps.find(
  (step) => step.name === "Validate the release inventory",
).run;
const updates = workflows["desktop-updates.yml"];
const updatesEnvironment = {
  GITHUB_EVENT_NAME: "release",
  GITHUB_REPOSITORY: "owner/repo",
  RELEASE_TAG: "v0.1.0-alpha.2",
};
const releaseEnvironment = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/tags/v0.1.0-alpha.2",
  GITHUB_REF_NAME: "v0.1.0-alpha.2",
  RELEASE_TAG: "v0.1.0-alpha.2",
};

/** Gives each attack fixture an empty directory and removes it after the test. */
function fixtureDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "nightfall-ci-security-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Builds tar fixtures without invoking any code carried inside the app payload. */
function appArchive(directory, options = {}) {
  execFileSync(
    "python3",
    [
      "-c",
      `import io, json, pathlib, plistlib, sys, tarfile
options = json.loads(sys.argv[1])
pathlib.Path("incoming").mkdir()
info = {
    "CFBundleIdentifier": "com.stewartadam.nightfall",
    "CFBundleShortVersionString": options.get("version", "0.1.0-alpha.2"),
    "CFBundleExecutable": "nightfall-app",
}
with tarfile.open("incoming/unsigned-macos.tar", "w") as archive:
    for name, data in [
        ("Nightfall.app/Contents/Info.plist", plistlib.dumps(info)),
        ("Nightfall.app/Contents/MacOS/nightfall-app", b"#!/bin/sh\\ntouch EXECUTED\\n"),
    ]:
        entry = tarfile.TarInfo(name)
        entry.size = len(data)
        entry.mode = 0o4755
        archive.addfile(entry, io.BytesIO(data))
    if "path" in options:
        entry = tarfile.TarInfo(options["path"])
        entry.type = options.get("type", "0").encode()
        entry.linkname = "../../outside"
        archive.addfile(entry, io.BytesIO(b""))
`,
      JSON.stringify(options),
    ],
    { cwd: directory },
  );
}

/** Runs the actual workflow validator with controlled event metadata and no credentials. */
function validateApp(directory, environment = {}) {
  return spawnSync("python3", ["-c", unpack], {
    cwd: directory,
    env: {
      ...process.env,
      ...releaseEnvironment,
      GITHUB_OUTPUT: join(directory, "outputs"),
      ...environment,
    },
    encoding: "utf8",
  });
}

/** Restricts repository authority to source acquisition and the isolated release boundary. */
test("builds and tests have no GitHub permissions or release secrets", () => {
  const exceptions = {
    "ci.yml/scope": { contents: "read" },
    "ci.yml/desktop": { contents: "read", "pull-requests": "read" },
    "ci.yml/release": { contents: "write" },
    "ci.yml/preview": { "pull-requests": "write" },
    "pr-commands.yml/recheck-cla": {
      checks: "read",
      issues: "write",
      "pull-requests": "write",
      statuses: "read",
    },
    "pr-commands.yml/republish": {
      actions: "write",
      checks: "read",
      issues: "write",
      "pull-requests": "write",
    },
    "playwright-full.yml/source": { contents: "read" },
    "desktop-artifacts.yml/release-note-metadata": {
      contents: "read",
      "pull-requests": "read",
    },
    "release-notes.yml/metadata": {
      contents: "read",
      "pull-requests": "read",
    },
    "release.yml/publish": { contents: "write" },
    "desktop-updates.yml/sign": { contents: "read" },
    "desktop-updates.yml/publish": { contents: "write" },
  };
  for (const [file, workflow] of Object.entries(workflows)) {
    assert.deepEqual(workflow.permissions, {}, file);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const key = `${file}/${id}`;
      assert.deepEqual(job.permissions ?? {}, exceptions[key] ?? {}, key);
      assert.notEqual(job.secrets, "inherit", key);
      if (
        file !== "release.yml" &&
        key !== "desktop-updates.yml/sign" &&
        !["release", "preview", "symbols"].includes(id)
      ) {
        assert.doesNotMatch(JSON.stringify(job), /secrets\./);
        if (!exceptions[key]) {
          assert.doesNotMatch(JSON.stringify(job), /github\.token/);
        }
      }
      for (const step of job.steps ?? []) {
        if (exceptions[key]) {
          assert.doesNotMatch(
            step.run ?? "",
            /\b(?:node|npm|npx|pnpm|cargo|rustup)\s/,
          );
        }
        if (step.uses && !step.uses.startsWith("./")) {
          assert.match(step.uses, /@[a-f0-9]{40}$/, key);
        }
      }
    }
  }
  const source = workflows["ci.yml"].jobs.scope;
  assert.equal(source.steps[0].with["persist-credentials"], false);
  assert.equal(source.steps[0].with.lfs, true);
  assert.doesNotMatch(
    JSON.stringify(source),
    /npm |cargo |rust-cache|actions\/cache/,
  );
});

/** Credential-bearing runners cannot restore a checkout, build tools, or a local action. */
test("signing and publishing only use pinned artifact actions and reviewed inline code", () => {
  for (const job of Object.values(release.jobs)) {
    assert.equal(
      job.if,
      "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
    for (const step of job.steps) {
      if (step.uses) {
        assert.match(
          step.uses,
          /^actions\/(?:upload|download)-artifact@[a-f0-9]{40}$/,
        );
      }
      assert.doesNotMatch(step.run ?? "", /\b(?:npm|npx|pnpm|cargo|rustup)\b/);
      assert.equal(step.with?.["run-id"], undefined);
      assert.equal(step.with?.["github-token"], undefined);
    }
  }
  assert.deepEqual(release.jobs.publish.needs, "sign");
  assert.deepEqual(workflows["ci.yml"].jobs.release.needs, "desktop");
});

/** Only the update signer holds the updater key, and it runs nothing but a verified minisign. */
test("update signing holds only the updater key and verifies its tool", () => {
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const secrets = JSON.stringify(job).match(/secrets\.TAURI_[A-Z_]+/g);
      if (file === "desktop-updates.yml" && id === "sign") {
        assert.deepEqual(secrets, [
          "secrets.TAURI_SIGNING_PRIVATE_KEY",
          "secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        ]);
        assert.doesNotMatch(JSON.stringify(job), /secrets\.APPLE_/);
      } else {
        assert.equal(secrets, null, `${file}/${id}`);
      }
    }
  }
  assert.deepEqual(updates.on, { release: { types: ["published"] } });
  assert.equal(updates.jobs.publish.needs, "sign");
  for (const job of Object.values(updates.jobs)) {
    for (const step of job.steps) {
      if (step.uses) {
        assert.match(
          step.uses,
          /^actions\/(?:upload|download)-artifact@[a-f0-9]{40}$/,
        );
      }
      assert.doesNotMatch(step.run ?? "", /\b(?:npm|npx|pnpm|cargo|rustup)\b/);
    }
  }
  const download = updates.jobs.sign.steps.find(
    (step) => step.env?.MINISIGN_SHA256,
  );
  assert.match(download.env.MINISIGN_SHA256, /^[a-f0-9]{64}$/);
  assert.match(download.run, /sha256sum --check --strict/);
});

/** The preview deployer holds only the Workers preview token and treats the demo artifact as data. */
test("browser previews deploy same-run artifacts without source or build tools", () => {
  const preview = workflows["ci.yml"].jobs.preview;
  assert.deepEqual(preview.needs, ["selection", "browser-demo"]);
  assert.equal(preview.if, "needs.selection.outputs.browser_preview == 'true'");
  assert.deepEqual(
    preview.steps.filter((step) => step.uses).map((step) => step.uses),
    [
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      "cloudflare/wrangler-action@953926a2e2182532811c01a25e53647d93bf07c0",
    ],
  );
  const secrets = JSON.stringify(preview).match(/secrets\.[A-Z_]+/g);
  assert.deepEqual(secrets, ["secrets.CLOUDFLARE_PREVIEW_TOKEN"]);
  assert.match(
    preview.steps.find((step) => step.id === "deploy").with.command,
    /^preview --name=pr-\$\{\{ needs\.selection\.outputs\.preview_pr \}\}$/,
  );
  for (const step of preview.steps) {
    assert.equal(step.with?.["run-id"], undefined);
    assert.equal(step.with?.["github-token"], undefined);
    assert.equal(step.with?.gitHubToken, undefined);
    assert.equal(step.with?.preCommands, undefined);
    assert.equal(step.with?.postCommands, undefined);
    assert.doesNotMatch(step.run ?? "", /\b(?:npm|npx|pnpm|cargo|rustup)\b/);
  }
});

/** The symbol uploader holds only the error service token, verifies its tool, and treats symbols as data. */
test("debug symbols upload same-run artifacts with a pinned, verified tool", () => {
  const symbols = workflows["ci.yml"].jobs.symbols;
  assert.equal(symbols.needs, "desktop");
  assert.equal(
    symbols.if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
  );
  assert.deepEqual(symbols.permissions ?? {}, {});
  assert.deepEqual(
    symbols.steps.filter((step) => step.uses).map((step) => step.uses),
    ["actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
  );
  assert.deepEqual(JSON.stringify(symbols).match(/secrets\.[A-Z_]+/g), [
    "secrets.GLITCHTIP_AUTH_TOKEN",
  ]);
  const download = symbols.steps.find((step) => step.env?.CLI_SHA256);
  assert.match(download.env.CLI_SHA256, /^[a-f0-9]{64}$/);
  assert.match(download.run, /sha256sum --check --strict/);
  for (const step of symbols.steps) {
    assert.equal(step.with?.["run-id"], undefined);
    assert.equal(step.with?.["github-token"], undefined);
    assert.doesNotMatch(step.run ?? "", /\b(?:npm|npx|pnpm|cargo|rustup)\b/);
  }
});

/** Source transfer retains tracked files and history while rejecting persisted authentication. */
test("source handoff retains Git metadata and media without hooks or credentials", (t) => {
  const directory = fixtureDirectory(t);
  const source = join(directory, "source");
  const restored = join(directory, "restored");
  mkdirSync(source);
  mkdirSync(restored);
  const options = {
    cwd: source,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      RUNNER_TEMP: directory,
    },
    encoding: "utf8",
  };
  execFileSync("git", ["init", "--quiet"], options);
  writeFileSync(join(source, "sample.mp3"), "resolved LFS media bytes");
  writeFileSync(join(source, ".hidden"), "hidden source input");
  execFileSync("git", ["add", "."], options);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    ],
    options,
  );
  mkdirSync(join(source, ".git/lfs"));
  writeFileSync(join(source, ".git/lfs/redundant-object"), "media bytes");
  const archive = workflows["ci.yml"].jobs.scope.steps.find(
    (step) => step.name === "Archive credential-free source and Git history",
  ).run;
  execFileSync("bash", ["-e", "-c", archive], options);
  mkdirSync(join(restored, ".ci-source"));
  execFileSync("cp", [
    join(directory, "source.tar"),
    join(restored, ".ci-source"),
  ]);
  const restore = workflows["ci.yml"].jobs["source-checks"].steps.find(
    (step) => step.name === "Restore source and Git history",
  ).run;
  execFileSync("bash", ["-e", "-c", restore], { ...options, cwd: restored });
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { ...options, cwd: restored }),
    execFileSync("git", ["rev-parse", "HEAD"], options),
  );
  assert.equal(
    execFileSync("git", ["ls-files"], { ...options, cwd: restored }),
    ".hidden\nsample.mp3\n",
  );
  assert.equal(
    readFileSync(join(restored, "sample.mp3"), "utf8"),
    "resolved LFS media bytes",
  );
  assert.equal(existsSync(join(restored, ".git/hooks")), false);
  assert.equal(existsSync(join(restored, ".git/lfs")), false);
  execFileSync(
    "git",
    ["config", "http.https://github.com/.extraheader", "secret"],
    options,
  );
  assert.notEqual(spawnSync("bash", ["-e", "-c", archive], options).status, 0);
});

/** Windows restores links without privileges, including targets later in the archive or absent. */
test("Windows source restoration uses Git's regular-file symlink representation", (t) => {
  const directory = fixtureDirectory(t);
  const options = {
    cwd: directory,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
  };
  execFileSync(
    "python3",
    [
      "-c",
      `
import io, pathlib, tarfile
pathlib.Path('.ci-source').mkdir()
with tarfile.open('.ci-source/source.tar', 'w') as archive:
    for name, target in [('CLAUDE.md', 'AGENTS.md'), ('dangling', 'absent')]:
        entry = tarfile.TarInfo(name)
        entry.type = tarfile.SYMTYPE
        entry.linkname = target
        archive.addfile(entry)
    for name, data in [('AGENTS.md', b'instructions'), ('.git/config', b'[core]\\nsymlinks = true\\n')]:
        entry = tarfile.TarInfo(name)
        entry.size = len(data)
        archive.addfile(entry, io.BytesIO(data))
`,
    ],
    { cwd: directory },
  );
  execFileSync("git", ["init", "--quiet"], options);
  const restore = workflows["desktop-artifacts.yml"].jobs.build.steps.find(
    (step) => step.name === "Restore Windows source and Git history",
  );
  assert.equal(restore.if, "runner.os == 'Windows'");
  assert.equal(restore.shell, "python");
  execFileSync("python3", ["-c", restore.run], options);
  assert.equal(readFileSync(join(directory, "CLAUDE.md"), "utf8"), "AGENTS.md");
  assert.equal(readFileSync(join(directory, "dangling"), "utf8"), "absent");
  assert.equal(
    readFileSync(join(directory, "AGENTS.md"), "utf8"),
    "instructions",
  );
  assert.equal(existsSync(join(directory, ".ci-source")), false);
  assert.match(
    readFileSync(join(directory, ".git/config"), "utf8"),
    /symlinks = false/,
  );
});

/** The payload is copied as bytes, retains executable bits, and never retains setuid bits. */
test("valid macOS payload is unpacked without executing its binary", (t) => {
  const directory = fixtureDirectory(t);
  appArchive(directory);
  const result = validateApp(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(directory, "EXECUTED")), false);
  assert.equal(
    statSync(
      join(directory, "payload/Nightfall.app/Contents/MacOS/nightfall-app"),
    ).mode & 0o7777,
    0o755,
  );
  assert.equal(
    readFileSync(join(directory, "outputs"), "utf8"),
    "filename=nightfall-v0.1.0-alpha.2-aarch64-apple-darwin.dmg\n",
  );
});

/** Malicious archive entries cannot escape the payload or replace runner tools through links. */
test("rejects traversal, links, devices, duplicate files, and unexpected roots", (t) => {
  for (const attack of [
    { path: "Nightfall.app/../../outside" },
    { path: "/tmp/outside" },
    { path: "script.sh" },
    { path: "Nightfall.app/Contents/link", type: "2" },
    { path: "Nightfall.app/Contents/hardlink", type: "1" },
    { path: "Nightfall.app/Contents/device", type: "3" },
    { path: "Nightfall.app/Contents/MacOS/nightfall-app" },
    { path: "Nightfall.app/Contents/line\nbreak" },
  ]) {
    const directory = fixtureDirectory(t);
    appArchive(directory, attack);
    const result = validateApp(directory);
    assert.notEqual(result.status, 0, JSON.stringify(attack));
    assert.match(result.stderr, /Unexpected app archive entry/);
    assert.equal(existsSync(join(directory, "outputs")), false);
  }
});

/** Artifact metadata cannot authorize signing on PRs, manual runs, or a mismatched tag. */
test("signing validates the event and app version independently of build outputs", (t) => {
  for (const environment of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF_NAME: "v0.1.0;touch PWNED" },
  ]) {
    const directory = fixtureDirectory(t);
    appArchive(directory);
    assert.notEqual(validateApp(directory, environment).status, 0);
    assert.equal(existsSync(join(directory, "outputs")), false);
  }
  const directory = fixtureDirectory(t);
  appArchive(directory, { version: "0.2.0" });
  assert.match(validateApp(directory).stderr, /differs from the release/);
});

/** Creates the installers, macOS update archive, and combined notices accepted by the publishing boundary. */
function releaseInventory(directory) {
  mkdirSync(join(directory, "release-assets"));
  mkdirSync(join(directory, "release-notes"));
  writeFileSync(join(directory, "release-notes/release-notes.md"), "Notes");
  for (const suffix of [
    "aarch64-apple-darwin.dmg",
    "aarch64-apple-darwin.app.tar.gz",
    "x86_64-pc-windows-msvc.exe",
    "x86_64-unknown-linux-gnu.deb",
    "x86_64-unknown-linux-gnu.AppImage",
  ]) {
    writeFileSync(
      join(directory, `release-assets/nightfall-v0.1.0-alpha.2-${suffix}`),
      "artifact bytes",
    );
  }
  writeFileSync(
    join(directory, "release-assets/THIRD-PARTY-NOTICES-v0.1.0-alpha.2.txt"),
    "combined licenses",
  );
}

/** Executes the exact publishing inventory guard before any token-bearing release command. */
function validateInventory(directory, environment = {}) {
  return spawnSync("bash", ["-c", inventory], {
    cwd: directory,
    env: { ...process.env, ...releaseEnvironment, ...environment },
    encoding: "utf8",
  });
}

/** Missing or extra assets and symlink substitution cannot silently enter a release. */
test("publishing requires the exact nonempty installer and notices inventory", (t) => {
  const directory = fixtureDirectory(t);
  releaseInventory(directory);
  assert.equal(validateInventory(directory).status, 0);
  assert.notEqual(
    validateInventory(directory, { GITHUB_EVENT_NAME: "workflow_dispatch" })
      .status,
    0,
  );
  const extra = join(directory, "release-assets/extra.sh");
  writeFileSync(extra, "touch EXECUTED");
  assert.notEqual(validateInventory(directory).status, 0);
  rmSync(extra);
  const dmg = join(
    directory,
    "release-assets/nightfall-v0.1.0-alpha.2-aarch64-apple-darwin.dmg",
  );
  rmSync(dmg);
  assert.notEqual(validateInventory(directory).status, 0);
  writeFileSync(dmg, "");
  assert.notEqual(validateInventory(directory).status, 0);
  rmSync(dmg);
  symlinkSync("../release-notes/release-notes.md", dmg);
  assert.notEqual(validateInventory(directory).status, 0);
  rmSync(dmg);
  writeFileSync(dmg, "artifact bytes");
  assert.equal(validateInventory(directory).status, 0);
});

/**
 * Runs the actual update signing step against a stand-in minisign that records each signature
 * request, so the manifest and package checks are exercised without the real signing key.
 */
function signUpdates(directory, environment = {}) {
  const step = updates.jobs.sign.steps.find(
    (candidate) =>
      candidate.name === "Sign the update packages and write the manifest",
  ).run;
  const tool = join(directory, "minisign-linux/x86_64");
  mkdirSync(tool, { recursive: true });
  writeFileSync(
    join(tool, "minisign"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = -S ]; then',
      '  while [ $# -gt 0 ]; do case "$1" in -x) out="$2"; shift;; -t) comment="$2"; shift;; esac; shift; done',
      "  read -r password",
      '  printf "signed with %s\\n%s\\n" "$password" "$comment" > "$out"',
      "fi",
    ].join("\n"),
    { mode: 0o755 },
  );
  return spawnSync("bash", ["-c", step], {
    cwd: directory,
    env: {
      ...process.env,
      ...updatesEnvironment,
      RUNNER_TEMP: directory,
      TAURI_SIGNING_PRIVATE_KEY: Buffer.from("secret key").toString("base64"),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "password",
      TAURI_SIGNING_PUBLIC_KEY: Buffer.from("public key").toString("base64"),
      ...environment,
    },
    encoding: "utf8",
  });
}

/** Each update package is signed for the tagged version and listed under the updater's lookup key. */
test("update manifest signs each package for the release version", (t) => {
  const directory = fixtureDirectory(t);
  mkdirSync(join(directory, "incoming"));
  const suffixes = {
    "darwin-aarch64-app": "aarch64-apple-darwin.app.tar.gz",
    "windows-x86_64-nsis": "x86_64-pc-windows-msvc.exe",
    "linux-x86_64-deb": "x86_64-unknown-linux-gnu.deb",
    "linux-x86_64-appimage": "x86_64-unknown-linux-gnu.AppImage",
  };
  for (const suffix of Object.values(suffixes)) {
    writeFileSync(
      join(directory, `incoming/nightfall-v0.1.0-alpha.2-${suffix}`),
      "package bytes",
    );
  }
  const result = signUpdates(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(directory, "updater.key")), false);
  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest/latest.json"), "utf8"),
  );
  assert.equal(manifest.version, "0.1.0-alpha.2");
  for (const [target, suffix] of Object.entries(suffixes)) {
    const name = `nightfall-v0.1.0-alpha.2-${suffix}`;
    const entry = manifest.platforms[target];
    assert.equal(
      entry.url,
      `https://github.com/owner/repo/releases/download/v0.1.0-alpha.2/${name}`,
    );
    const signature = Buffer.from(entry.signature, "base64").toString();
    assert.match(signature, /^signed with password\n/);
    assert.match(
      signature,
      new RegExp(
        `\tfile:${name.replaceAll(".", "\\.")}\tversion:0\\.1\\.0-alpha\\.2\n$`,
      ),
    );
  }
  assert.deepEqual(
    manifest.platforms["darwin-aarch64"],
    manifest.platforms["darwin-aarch64-app"],
  );
  assert.deepEqual(
    manifest.platforms["windows-x86_64"],
    manifest.platforms["windows-x86_64-nsis"],
  );
  assert.equal(manifest.platforms["linux-x86_64"], undefined);
});

/** A missing package, missing key, or untagged run never produces a manifest. */
test("update signing refuses incomplete releases and missing keys", (t) => {
  const directory = fixtureDirectory(t);
  mkdirSync(join(directory, "incoming"));
  writeFileSync(
    join(
      directory,
      "incoming/nightfall-v0.1.0-alpha.2-x86_64-pc-windows-msvc.exe",
    ),
    "package bytes",
  );
  assert.notEqual(signUpdates(directory).status, 0);
  assert.notEqual(
    signUpdates(directory, { TAURI_SIGNING_PUBLIC_KEY: "" }).status,
    0,
  );
  assert.notEqual(
    signUpdates(directory, { GITHUB_EVENT_NAME: "workflow_dispatch" }).status,
    0,
  );
  assert.equal(existsSync(join(directory, "manifest/latest.json")), false);
});

/**
 * Runs the actual updater-release step with a stand-in `gh` that records its arguments, and
 * reports whether the `updater` release already exists through `existing`.
 */
function offerUpdate(
  directory,
  manifest,
  { existing = true, current = "0.1.0-alpha.1", ...environment } = {},
) {
  const step = updates.jobs.publish.steps.find(
    (candidate) =>
      candidate.name === "Replace the manifest on the updater release",
  ).run;
  mkdirSync(join(directory, "manifest"), { recursive: true });
  writeFileSync(
    join(directory, "manifest/latest.json"),
    JSON.stringify(manifest),
  );
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$GH_LOG"',
      `if [ "$2" = view ]; then exit ${existing ? 0 : 1}; fi`,
      'if [ "$2" = download ]; then printf \'{"version":"%s"}\' "$CURRENT_VERSION" > "$7"; fi',
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", step], {
    cwd: directory,
    env: {
      ...process.env,
      ...updatesEnvironment,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: join(directory, "gh.log"),
      CURRENT_VERSION: current,
      GH_REPO: "owner/repo",
      RUNNER_TEMP: directory,
      GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
      ...environment,
    },
    encoding: "utf8",
  });
  const log = join(directory, "gh.log");
  return {
    status: result.status,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

/**
 * Runs the actual package download step against a stand-in `gh` whose release lists `assets`,
 * returning the step's exit status and the packages it downloaded.
 */
function downloadPackages(directory, assets) {
  const step = updates.jobs.sign.steps.find(
    (candidate) => candidate.name === "Download the release packages",
  ).run;
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(directory, "assets.json"), JSON.stringify({ assets }));
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = api ]; then cat "$RELEASE_JSON"; exit; fi',
      'printf "%s\\n" "$7" >> "$GH_LOG"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", step], {
    cwd: directory,
    env: {
      ...process.env,
      ...updatesEnvironment,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: join(directory, "gh.log"),
      GH_REPO: "owner/repo",
      RELEASE_JSON: join(directory, "assets.json"),
      RUNNER_TEMP: directory,
    },
    encoding: "utf8",
  });
  const log = join(directory, "gh.log");
  return {
    status: result.status,
    downloaded: existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n")
      : [],
  };
}

/** Only the four update packages the release workflow uploaded are fetched for signing. */
test("update signing only fetches packages the release workflow uploaded", (t) => {
  const directory = fixtureDirectory(t);
  const names = [
    "aarch64-apple-darwin.app.tar.gz",
    "x86_64-pc-windows-msvc.exe",
    "x86_64-unknown-linux-gnu.deb",
    "x86_64-unknown-linux-gnu.AppImage",
  ].map((suffix) => `nightfall-v0.1.0-alpha.2-${suffix}`);
  const asset = (name, login = "github-actions[bot]") => ({
    name,
    uploader: { login },
  });
  const workflowAssets = [
    ...names.map((name) => asset(name)),
    asset("nightfall-v0.1.0-alpha.2-aarch64-apple-darwin.dmg"),
  ];
  assert.deepEqual(downloadPackages(directory, workflowAssets), {
    status: 0,
    downloaded: names,
  });
  rmSync(join(directory, "gh.log"));
  const replaced = workflowAssets.map((entry) =>
    entry.name === names[1] ? asset(entry.name, "someone") : entry,
  );
  assert.notEqual(downloadPackages(directory, replaced).status, 0);
  rmSync(join(directory, "gh.log"), { force: true });
  const missing = workflowAssets.filter((entry) => entry.name !== names[3]);
  assert.notEqual(downloadPackages(directory, missing).status, 0);
});

/** Builds a manifest for `version` whose one package downloads from `url`. */
function updateManifest(
  version = "0.1.0-alpha.2",
  url = `https://github.com/owner/repo/releases/download/v${version}/nightfall.exe`,
) {
  return {
    version,
    platforms: { "windows-x86_64-nsis": { url, signature: "c2lnbmVk" } },
  };
}

/** Publishing replaces the manifest on the updater release, creating that release only once. */
test("published releases replace the manifest on the updater release", (t) => {
  const directory = fixtureDirectory(t);
  const replaced = offerUpdate(directory, updateManifest());
  assert.equal(replaced.status, 0);
  assert.deepEqual(replaced.calls, [
    "release view updater",
    `release download updater --pattern latest.json --output ${directory}/current.json`,
    "release upload updater manifest/latest.json --clobber",
  ]);
  rmSync(join(directory, "gh.log"));
  const created = offerUpdate(directory, updateManifest(), { existing: false });
  assert.equal(created.status, 0);
  assert.match(
    created.calls[1],
    /^release create updater --prerelease --latest=false /,
  );
  assert.equal(
    created.calls[2],
    "release upload updater manifest/latest.json --clobber",
  );
});

/**
 * A manifest for another version or another release's files, a run outside a release event,
 * or an older release than the one already offered uploads nothing.
 */
test("the updater release only accepts the published release's manifest", (t) => {
  const directory = fixtureDirectory(t);
  const rejected = [
    offerUpdate(directory, updateManifest("0.1.0-alpha.1")),
    offerUpdate(directory, { version: "0.1.0-alpha.2", platforms: {} }),
    offerUpdate(
      directory,
      updateManifest("0.1.0-alpha.2", "https://example.com/nightfall.exe"),
    ),
    offerUpdate(
      directory,
      updateManifest(
        "0.1.0-alpha.2",
        "https://github.com/owner/repo/releases/download/v0.1.0-alpha.2/../v0.0.1/nightfall.exe",
      ),
    ),
    offerUpdate(directory, updateManifest(), {
      GITHUB_EVENT_NAME: "workflow_dispatch",
    }),
  ];
  for (const result of rejected) {
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  }
  for (const current of ["0.1.0-alpha.10", "0.1.0", "0.2.0-alpha.1"]) {
    const downgrade = offerUpdate(directory, updateManifest(), { current });
    assert.notEqual(downgrade.status, 0, current);
    assert.doesNotMatch(downgrade.calls.join("\n"), /upload/, current);
    rmSync(join(directory, "gh.log"));
  }
  for (const current of ["0.1.0-alpha.2", "0.1.0-alpha.1", "0.1.0-1"]) {
    assert.equal(
      offerUpdate(directory, updateManifest(), { current }).status,
      0,
      current,
    );
  }
});

/** A build-generated metadata plan cannot turn authenticated API calls into arbitrary endpoints. */
test("PR metadata acquisition rejects paths and malformed commit IDs", (t) => {
  const fetch = workflows["desktop-artifacts.yml"].jobs[
    "release-note-metadata"
  ].steps.find(
    (step) => step.name === "Fetch only validated commit associations",
  ).run;
  for (const commits of [
    ["../secrets"],
    ["a".repeat(40), "$(touch EXECUTED)"],
    [42],
    { unexpected: [] },
  ]) {
    const directory = fixtureDirectory(t);
    mkdirSync(join(directory, "requests"));
    writeFileSync(
      join(directory, "requests/commits.json"),
      JSON.stringify(commits),
    );
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", fetch], {
      cwd: directory,
      env: { ...process.env, RUNNER_TEMP: directory, GH_REPO: "owner/repo" },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(directory, "release-metadata")), false);
  }
});
