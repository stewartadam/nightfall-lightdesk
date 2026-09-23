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
    "ci-precommit.yml/scope": { contents: "read" },
    "ci-precommit.yml/desktop": { contents: "read", "pull-requests": "read" },
    "ci-precommit.yml/release": { contents: "write" },
    "desktop-artifacts.yml/release-note-metadata": {
      contents: "read",
      "pull-requests": "read",
    },
    "release-notes.yml/metadata": {
      contents: "read",
      "pull-requests": "read",
    },
    "release.yml/publish": { contents: "write" },
  };
  for (const [file, workflow] of Object.entries(workflows)) {
    assert.deepEqual(workflow.permissions, {}, file);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const key = `${file}/${id}`;
      assert.deepEqual(job.permissions ?? {}, exceptions[key] ?? {}, key);
      assert.notEqual(job.secrets, "inherit", key);
      if (file !== "release.yml" && id !== "release") {
        assert.doesNotMatch(JSON.stringify(job), /secrets\./);
        if (!exceptions[key]) {
          assert.doesNotMatch(JSON.stringify(job), /github\.token/);
        }
      }
      for (const step of job.steps ?? []) {
        if (exceptions[key]) {
          assert.doesNotMatch(
            step.run ?? "",
            /\b(?:node|npm|npx|cargo|rustup)\s/,
          );
        }
        if (step.uses && !step.uses.startsWith("./")) {
          assert.match(step.uses, /@[a-f0-9]{40}$/, key);
        }
      }
    }
  }
  const source = workflows["ci-precommit.yml"].jobs.scope;
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
      assert.doesNotMatch(step.run ?? "", /\b(?:npm|npx|cargo|rustup)\b/);
      assert.equal(step.with?.["run-id"], undefined);
      assert.equal(step.with?.["github-token"], undefined);
    }
  }
  assert.deepEqual(release.jobs.publish.needs, "sign");
  assert.deepEqual(workflows["ci-precommit.yml"].jobs.release.needs, "desktop");
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
  const archive = workflows["ci-precommit.yml"].jobs.scope.steps.find(
    (step) => step.name === "Archive credential-free source and Git history",
  ).run;
  execFileSync("bash", ["-e", "-c", archive], options);
  mkdirSync(join(restored, ".ci-source"));
  execFileSync("cp", [
    join(directory, "source.tar"),
    join(restored, ".ci-source"),
  ]);
  const restore = workflows["ci-precommit.yml"].jobs.native.steps.find(
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

/** Creates the installers and combined notices accepted by the publishing boundary. */
function releaseInventory(directory) {
  mkdirSync(join(directory, "release-assets"));
  mkdirSync(join(directory, "release-notes"));
  writeFileSync(join(directory, "release-notes/release-notes.md"), "Notes");
  for (const suffix of [
    "aarch64-apple-darwin.dmg",
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
