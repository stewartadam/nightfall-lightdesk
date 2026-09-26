// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { clonePlaywrightDataDir } from "./nightfall-test-data-dir.mjs";
import { terminateRegisteredProcesses } from "./owned-process.mjs";

const SERVICE_POLL_INTERVAL_MS = 50;
const SERVICE_REQUEST_TIMEOUT_MS = 1_000;
const SERVICE_SHUTDOWN_TIMEOUT_MS = 2_000;

/** Waits for the requested number of milliseconds. */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Opens a temporary loopback listener and returns its assigned port. */
function openEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not resolve an ephemeral TCP port"));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

/** Closes a temporary port reservation. */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Atomically claims both ports against every other worker in this test run. */
function claimPortPair(runRoot, backendPort) {
  const claimPaths = [backendPort, backendPort + 1].map((port) =>
    join(runRoot, `port-${port}`),
  );
  const claimedPaths = [];
  try {
    for (const claimPath of claimPaths) {
      closeSync(openSync(claimPath, "wx"));
      claimedPaths.push(claimPath);
    }
    return claimPaths;
  } catch (error) {
    for (const claimPath of claimedPaths) {
      rmSync(claimPath, { force: true });
    }
    if (error && typeof error === "object" && error.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

/** Finds and claims two consecutive ports for one worker's backend and Vite. */
export async function claimAvailablePortPair(runRoot) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const backend = await openEphemeralPort();
    if (backend.port >= 65_535) {
      await closeServer(backend.server);
      continue;
    }

    const frontend = createServer();
    const frontendAvailable = await new Promise((resolve) => {
      frontend.once("error", () => resolve(false));
      frontend.listen(backend.port + 1, "127.0.0.1", () => resolve(true));
    });
    if (!frontendAvailable) {
      await closeServer(backend.server);
      continue;
    }

    const claimPaths = claimPortPair(runRoot, backend.port);
    await Promise.all([closeServer(backend.server), closeServer(frontend)]);
    if (claimPaths) {
      return { backendPort: backend.port, claimPaths };
    }
  }
  throw new Error("Could not claim consecutive Playwright service ports");
}

/** Returns a short stable identifier suitable for a registry filename. */
function shortIdentifier(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Waits until a service responds successfully or its child exits. */
async function waitForService(child, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Service process exited before ${url} became ready`);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(SERVICE_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return;
    } catch {
      // Startup connection failures are expected until the listener binds.
    }
    await delay(SERVICE_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Playwright service at ${url}`);
}

/** Starts one registered service wrapper and waits for its health endpoint. */
async function startService({
  environment,
  registryPath,
  scriptName,
  timeoutMs,
  url,
}) {
  const child = spawn(process.execPath, [join("scripts", scriptName)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
      NIGHTFALL_PLAYWRIGHT_PROCESS_REGISTRY: registryPath,
    },
    stdio: "inherit",
  });
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  try {
    await waitForService(child, url, timeoutMs);
    if (spawnError) throw spawnError;
    return { child, registryPath };
  } catch (error) {
    try {
      await terminateRegisteredProcesses(
        registryPath,
        SERVICE_SHUTDOWN_TIMEOUT_MS,
      );
    } finally {
      rmSync(registryPath, { force: true });
    }
    throw spawnError ?? error;
  }
}

/** Stops one registered service wrapper and removes its ownership registry. */
async function stopService(service) {
  if (!service) return;
  try {
    await terminateRegisteredProcesses(
      service.registryPath,
      SERVICE_SHUTDOWN_TIMEOUT_MS,
    );
  } finally {
    rmSync(service.registryPath, { force: true });
  }
}

/** Starts one worker-scoped Vite proxy on a claimed service port pair. */
export async function startPlaywrightWorkerSlot({ runRoot, workerIndex }) {
  const { backendPort, claimPaths } = await claimAvailablePortPair(runRoot);
  const baseURL = `http://127.0.0.1:${backendPort + 1}`;
  const registryPath = join(runRoot, `worker-${workerIndex}-vite.jsonl`);
  try {
    const viteService = await startService({
      environment: { NIGHTFALL_PORT: String(backendPort) },
      registryPath,
      scriptName: "run-playwright-vite.mjs",
      timeoutMs: 120_000,
      url: baseURL,
    });
    return {
      backendPort,
      baseURL,
      claimPaths,
      runRoot,
      viteService,
      workerIndex,
    };
  } catch (error) {
    for (const claimPath of claimPaths) {
      rmSync(claimPath, { force: true });
    }
    throw error;
  }
}

/** Stops one worker's Vite proxy and releases its claimed port pair. */
export async function stopPlaywrightWorkerSlot(workerSlot) {
  try {
    await stopService(workerSlot.viteService);
  } finally {
    for (const claimPath of workerSlot.claimPaths) {
      rmSync(claimPath, { force: true });
    }
  }
}

/**
 * Returns backend environment that bootstraps and saves the sample show when the
 * seed lacks the stable E2E showfiles. Tests of the startup flow opt out so the
 * backend stays Initialized (no world loaded) regardless of the developer's data.
 */
export function sampleDataBootstrapEnvironment({
  seedDataAvailable,
  emptyStartupWorld,
}) {
  if (seedDataAvailable || emptyStartupWorld) return {};
  return {
    NIGHTFALL_SAMPLE_DATA: "1",
    NIGHTFALL_STARTUP_CMDS: "save sample; save default",
  };
}

/** Starts a freshly seeded backend for one test on its worker's fixed port. */
export async function startPlaywrightTestBackend({
  emptyStartupWorld = false,
  experimentalFlows = false,
  seedDataDir,
  testId,
  workerSlot,
}) {
  const testKey = shortIdentifier(testId);
  const { runDataDir: dataDir, seedDataAvailable } = clonePlaywrightDataDir(
    seedDataDir,
    workerSlot.runRoot,
  );
  const registryPath = join(
    workerSlot.runRoot,
    `worker-${workerSlot.workerIndex}-test-${testKey}.jsonl`,
  );
  let backendService;
  try {
    backendService = await startService({
      environment: {
        RUST_LOG: process.env.NIGHTFALL_PLAYWRIGHT_RUST_LOG ?? "error",
        NIGHTFALL_DATA_DIR: dataDir,
        NIGHTFALL_INPUT_ARTNET: "false",
        NIGHTFALL_INPUT_SACN_ENABLED: "false",
        NIGHTFALL_OUTPUT_ARTNET: "false",
        NIGHTFALL_OUTPUT_SACN_ENABLED: "false",
        NIGHTFALL_OUTPUT_USB: "false",
        NIGHTFALL_EXPERIMENTAL_FLOWS: experimentalFlows ? "1" : "0",
        NIGHTFALL_PORT: String(workerSlot.backendPort),
        NIGHTFALL_TIMELINE_AUDIO_ENABLED:
          process.env.NIGHTFALL_TIMELINE_AUDIO_ENABLED ?? "0",
        ...sampleDataBootstrapEnvironment({
          seedDataAvailable,
          emptyStartupWorld,
        }),
      },
      registryPath,
      scriptName: "run-playwright-backend.mjs",
      timeoutMs: 180_000,
      url: `http://127.0.0.1:${workerSlot.backendPort}/api/showfiles`,
    });
    return {
      ...workerSlot,
      backendService,
      dataDir,
      testId,
    };
  } catch (error) {
    try {
      await stopService(backendService);
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
    throw error;
  }
}

/** Stops one test backend and removes its disposable application data. */
export async function stopPlaywrightTestBackend(testBackend) {
  try {
    await stopService(testBackend.backendService);
  } finally {
    rmSync(testBackend.dataDir, { force: true, recursive: true });
  }
}

/** Sweeps every service registry left by workers that did not tear down. */
export async function terminatePlaywrightBackendPool(runRoot) {
  if (!runRoot) return;
  const registryPaths = readdirSync(runRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(runRoot, entry.name));
  await Promise.all(
    registryPaths.map((registryPath) =>
      terminateRegisteredProcesses(registryPath, SERVICE_SHUTDOWN_TIMEOUT_MS),
    ),
  );
}
