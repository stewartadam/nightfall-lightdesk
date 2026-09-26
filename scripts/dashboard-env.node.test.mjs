// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dashboardUrl = new URL(
  "../worktree-dashboard/worktree-dashboard.mjs",
  import.meta.url,
).href;

/** Verifies every service uses target settings without leaking dashboard dotenv values. */
test("services use worktree dotenv beneath explicit lifecycle overrides", async (t) => {
  const cwd = await mkdtemp(
    join(tmpdir(), "nightfall-dashboard-services-env-"),
  );
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, ".env"),
    "NIGHTFALL_PORT=5172\nNIGHTFALL_CARGO_COMMAND=dashboard-cargo\nNIGHTFALL_DATA_DIR=/dashboard/data\nNIGHTFALL_STARTUP_CMDS=fps 30\nDASHBOARD_ONLY_SETTING=private\n",
  );
  await mkdir(join(cwd, "worktree"));
  await writeFile(
    join(cwd, "worktree", ".env"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: These substitutions belong to the dotenv fixture.
    'NIGHTFALL_PORT=3079 # local backend\nNIGHTFALL_CARGO_COMMAND="${HOME}/bin/worktree-cargo"\nNIGHTFALL_DATA_DIR="${WORKTREE_DATA_ROOT}/data #1"\nWORKTREE_DATA_ROOT="${HOME}/worktree"\nPATH="/extra:${PATH}"\nNIGHTFALL_STARTUP_CMDS="fps 10" # startup\nNIGHTFALL_SAMPLE_DATA=0\n',
  );
  const env = { ...process.env, NIGHTFALL_WORKTREE_DASHBOARD_PORT: "0" };
  for (const key of [
    "NIGHTFALL_PORT",
    "NIGHTFALL_CARGO_COMMAND",
    "NIGHTFALL_DATA_DIR",
    "NIGHTFALL_STARTUP_CMDS",
    "DASHBOARD_ONLY_SETTING",
  ]) {
    delete env[key];
  }
  const script = `
    import assert from "node:assert/strict";
    const launcherPort = process.env.NIGHTFALL_PORT;
    const launcherCargo = process.env.NIGHTFALL_CARGO_COMMAND;
    const { processEnvForService, readEnvMap, commandForService } = await import(${JSON.stringify(dashboardUrl)});
    const { values: target } = await readEnvMap(cwd + "/worktree");
    assert.deepEqual({ ...target }, {
      NIGHTFALL_PORT: "3079",
      NIGHTFALL_CARGO_COMMAND: process.env.HOME + "/bin/worktree-cargo",
      NIGHTFALL_DATA_DIR: process.env.HOME + "/worktree/data #1",
      NIGHTFALL_STARTUP_CMDS: "fps 10",
      NIGHTFALL_SAMPLE_DATA: "0",
      WORKTREE_DATA_ROOT: process.env.HOME + "/worktree",
      PATH: "/extra:" + process.env.PATH,
    });
    for (const service of ["backend", "ui", "wasm", "artnet-sender", "sacn-sender"]) {
      const childEnv = processEnvForService(service, cwd + "/worktree", target);
      for (const [key, value] of Object.entries(target)) assert.equal(childEnv[key], value);
      assert.equal(childEnv.DASHBOARD_ONLY_SETTING, undefined);
      assert.equal(childEnv.PATH, "/extra:" + process.env.PATH);
      const command = commandForService(service, childEnv);
      if (["artnet-sender", "sacn-sender"].includes(service)) {
        assert.equal(command.command, target.NIGHTFALL_CARGO_COMMAND);
        assert.equal(command.label, command.command + " " + command.args.join(" "));
      } else if (service === "backend") {
        assert.equal(command.command, process.execPath);
        assert.deepEqual(command.args, [${JSON.stringify(fileURLToPath(new URL("./run-native-cargo.mjs", import.meta.url)))}, "run"]);
      } else {
        assert.equal(command.command, process.platform === "win32" ? "npm.cmd" : "npm");
      }
    }
    const defaults = processEnvForService("backend", cwd + "/worktree");
    assert.equal(defaults.NIGHTFALL_PORT, launcherPort);
    assert.equal(defaults.NIGHTFALL_DATA_DIR, undefined);
    assert.equal(defaults.NIGHTFALL_STARTUP_CMDS, "fps 5");
    const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
    assert.equal(commandForService("artnet-sender", defaults).command, launcherCargo || cargo);
    assert.equal(commandForService("artnet-sender", { NIGHTFALL_CARGO_COMMAND: " " }).command, cargo);
    const other = processEnvForService("backend", cwd + "/other", { NIGHTFALL_CARGO_COMMAND: "other-cargo" });
    assert.equal(commandForService("artnet-sender", other).command, "other-cargo");
    const sample = processEnvForService("backend", cwd + "/worktree", target, { sampleData: true });
    assert.equal(sample.NIGHTFALL_SAMPLE_DATA, "1");
    const root = processEnvForService("backend", cwd, target);
    assert.equal(root.NIGHTFALL_DATA_DIR, target.NIGHTFALL_DATA_DIR);
    assert.equal(root.NIGHTFALL_STARTUP_CMDS, "");
    assert.equal(processEnvForService("backend", cwd).NIGHTFALL_DATA_DIR, "");
    process.exit(0);
  `;
  await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", `const cwd = process.cwd(); ${script}`],
    { cwd, env: { ...env, HOME: cwd } },
  );
  await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", `const cwd = process.cwd(); ${script}`],
    {
      cwd,
      env: {
        ...env,
        HOME: cwd,
        NIGHTFALL_PORT: "9000",
        NIGHTFALL_CARGO_COMMAND: "launcher-cargo",
      },
    },
  );
});

/** Verifies dashboard startup loads optional dotenv settings beneath shell overrides. */
test("dashboard loads startup dotenv and respects exported settings", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "nightfall-dashboard-env-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = { ...process.env, NIGHTFALL_WORKTREE_DASHBOARD_PORT: "0" };
  delete env.NIGHTFALL_CARGO_COMMAND;
  const script = `await import(${JSON.stringify(dashboardUrl)}); process.stdout.write(JSON.stringify({ command: process.env.NIGHTFALL_CARGO_COMMAND ?? null })); process.exit(0);`;

  const missing = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd, env },
  );
  assert.equal(JSON.parse(missing.stdout).command, null);

  await writeFile(join(cwd, ".env"), "NIGHTFALL_CARGO_COMMAND=mbx\n");
  const loaded = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd, env },
  );
  assert.equal(JSON.parse(loaded.stdout).command, "mbx");

  const overridden = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd, env: { ...env, NIGHTFALL_CARGO_COMMAND: "custom-cargo" } },
  );
  assert.equal(JSON.parse(overridden.stdout).command, "custom-cargo");
});
