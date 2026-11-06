// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRequestGuard,
  parseAllowedOrigins,
} from "../worktree-dashboard/request-guard.mjs";

const check = createRequestGuard({
  dashboardHost: "127.0.0.1",
  allowedOrigins: ["https://dash.example.test"],
});

/** Verifies clients without an Origin, such as the MCP server, pass when they address this machine. */
test("non-browser clients on a local address pass", () => {
  assert.deepEqual(check({ host: "127.0.0.1:4780" }), { allowed: true });
  assert.deepEqual(check({ host: "localhost:4780" }), { allowed: true });
  assert.deepEqual(check({ host: "[::1]:4780" }), { allowed: true });
  assert.deepEqual(check({ host: "LOCALHOST" }), { allowed: true });
});

/** Verifies a Host naming another machine, as after DNS rebinding, or no Host at all is refused. */
test("a rebound or missing Host is refused", () => {
  const rebound = check({ host: "evil.example.com:4780" });
  assert.equal(rebound.allowed, false);
  assert.match(rebound.reason, /Host not allowed: evil\.example\.com:4780/u);
  assert.equal(check({}).allowed, false);
  assert.equal(check({ host: "" }).allowed, false);
});

/** Verifies remote, opaque and look-alike origins are refused even on a local Host. */
test("a remote or opaque Origin is refused", () => {
  const host = "127.0.0.1:4780";
  const remote = check({ host, origin: "https://evil.example.com" });
  assert.equal(remote.allowed, false);
  assert.match(remote.reason, /NIGHTFALL_WORKTREE_DASHBOARD_ALLOWED_ORIGINS/u);
  assert.equal(check({ host, origin: "null" }).allowed, false);
  assert.equal(
    check({ host, origin: "http://localhost.evil.com" }).allowed,
    false,
  );
  assert.equal(
    check({ host, origin: "https://dash.example.test.evil.com" }).allowed,
    false,
  );
});

/** Verifies loopback origins always pass, and listed origins pass along with their hostname as Host. */
test("loopback and allowed origins pass", () => {
  const host = "127.0.0.1:4780";
  assert.deepEqual(check({ host, origin: "http://localhost:3031" }), {
    allowed: true,
  });
  assert.deepEqual(check({ host, origin: "http://[::1]:3031" }), {
    allowed: true,
  });
  assert.deepEqual(check({ host, origin: "https://dash.example.test" }), {
    allowed: true,
  });
  assert.equal(check({ host: "dash.example.test:4780" }).allowed, true);
});

/** Verifies the address the dashboard listens on is accepted as Host. */
test("the dashboard's own listen address is accepted as Host", () => {
  const lan = createRequestGuard({ dashboardHost: "192.168.1.20" });
  assert.equal(lan({ host: "192.168.1.20:4780" }).allowed, true);
  assert.equal(lan({ host: "192.168.1.21:4780" }).allowed, false);
});

/** Verifies the env list is split, trimmed and stripped of trailing slashes and blanks. */
test("parseAllowedOrigins trims entries", () => {
  assert.deepEqual(parseAllowedOrigins(" http://a.test/, ,http://b.test "), [
    "http://a.test",
    "http://b.test",
  ]);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

/** Starts the real dashboard on an ephemeral port in an empty directory and resolves with its port. */
async function startDashboard(t) {
  const cwd = await mkdtemp(join(tmpdir(), "nightfall-dashboard-guard-"));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../worktree-dashboard/worktree-dashboard.mjs",
          import.meta.url,
        ),
      ),
    ],
    {
      cwd,
      env: {
        ...process.env,
        NIGHTFALL_WORKTREE_DASHBOARD_PORT: "0",
        NIGHTFALL_WORKTREE_DASHBOARD_HOST: "127.0.0.1",
        NIGHTFALL_WORKTREE_DASHBOARD_ALLOWED_ORIGINS:
          "https://dash.example.test",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  t.after(async () => {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`dashboard exited early with code ${code}`)),
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on http:\/\/[^:]+:(\d+)/u);
      if (match) resolve(Number(match[1]));
    });
  });
}

/** Sends a POST with exact Host and Origin headers, which `fetch` would not let a test set. */
function post(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Verifies the dashboard answers 403 to a cross-origin or rebound POST before routing it. */
test("the dashboard refuses a cross-origin POST to create a worktree", async (t) => {
  const port = await startDashboard(t);

  const crossOrigin = await post(port, "/api/worktrees?branch=pwned", {
    Origin: "https://evil.example.com",
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.body, /Origin not allowed/u);

  const rebound = await post(port, "/api/worktrees?branch=pwned", {
    Host: `evil.example.com:${port}`,
  });
  assert.equal(rebound.status, 403);
  assert.match(rebound.body, /Host not allowed/u);

  // Allowed requests are routed: an unknown path answers 404, not 403.
  for (const headers of [
    {},
    { Origin: `http://localhost:${port + 1}` },
    { Origin: "https://dash.example.test" },
  ]) {
    const routed = await post(port, "/not-a-route", headers);
    assert.equal(routed.status, 404, JSON.stringify(headers));
  }
});
