// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  registerOwnedProcess,
  runOwnedCommand,
} from "../../scripts/owned-process.mjs";
import { test as backendTest, expect, type Page } from "./playwright-fixtures";

const EXAMPLE_NAME = "virtual_controller";
const EXAMPLE_SOURCE = join(
  process.cwd(),
  "crates",
  "input_midi",
  "examples",
  `${EXAMPLE_NAME}.rs`,
);
const READY_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 5_000;

/** A virtual MIDI controller whose port the backend connects to like real hardware. */
export interface VirtualMidi {
  /** Port name the backend reports as the MIDI device name. */
  readonly name: string;
  /** Sends one raw MIDI message and resolves once the port has emitted it. */
  send(bytes: number[]): Promise<void>;
  /** Presses (`on`) or releases a note on a zero-based channel. */
  note(
    note: number,
    on: boolean,
    options?: { channel?: number; velocity?: number },
  ): Promise<void>;
  /** Moves a continuous controller to a 7-bit value on a zero-based channel. */
  cc(controller: number, value: number, channel?: number): Promise<void>;
  /** Moves the pitch bend wheel to a 14-bit value (0-16383) on a zero-based channel. */
  pitchBend(value: number, channel?: number): Promise<void>;
  /** Closes the port by ending the controller's input and waits for it to exit. */
  close(): Promise<void>;
}

/** Returns why virtual MIDI ports cannot be opened on this host, or undefined when they can. */
export function virtualMidiUnavailableReason(): string | undefined {
  if (process.platform === "win32") {
    return "Windows has no virtual MIDI port API";
  }
  if (process.platform === "linux" && !existsSync("/dev/snd/seq")) {
    return "ALSA sequencer (/dev/snd/seq) is unavailable";
  }
  return undefined;
}

/** Returns the path Cargo writes the virtual controller example to in the shared target dir. */
function exampleExecutablePath(): string {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version=1", "--no-deps"], {
      encoding: "utf8",
    }),
  ) as { target_directory: string };
  return join(metadata.target_directory, "debug", "examples", EXAMPLE_NAME);
}

/**
 * Returns the virtual controller executable, building it first when it is missing or older
 * than its source.
 *
 * The build uses the same Cargo feature graph as the Playwright backend, so it reuses the
 * backend's compiled dependencies and only compiles and links the example itself.
 */
async function ensureExampleExecutable(): Promise<string> {
  const executable = exampleExecutablePath();
  const fresh =
    existsSync(executable) &&
    statSync(executable).mtimeMs >= statSync(EXAMPLE_SOURCE).mtimeMs;
  if (fresh) return executable;

  const outcome = await runOwnedCommand(
    "cargo",
    ["build", "--tests", "--quiet", "--example", EXAMPLE_NAME],
    { spawnOptions: { stdio: "inherit" } },
  );
  if (outcome.code !== 0 || outcome.signal) {
    throw new Error(
      `Building the ${EXAMPLE_NAME} example failed (code ${outcome.code}, signal ${outcome.signal})`,
    );
  }
  return executable;
}

/** Waits for a child process to exit, resolving immediately when it already has. */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** Clamps a number to an integer MIDI data byte. */
function dataByte(value: number): number {
  return Math.max(0, Math.min(127, Math.round(value)));
}

/**
 * Starts the virtual controller example with a port of the given name.
 *
 * The process is registered with the Playwright run so the wrapper terminates it if this
 * worker dies, and it also exits by itself when its stdin closes with the worker.
 */
async function openVirtualMidi(
  executable: string,
  name: string,
  registryPath: string | undefined,
): Promise<VirtualMidi> {
  const child = spawn(executable, [name], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (registryPath && child.pid) {
    registerOwnedProcess(registryPath, child.pid, process.platform !== "win32");
  }
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const lines = createInterface({ input: child.stdout! });
  const waiting: {
    expected: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  /** Fails every pending wait once the controller exits before acknowledging it. */
  const failPending = () => {
    for (const pending of waiting.splice(0)) {
      pending.reject(
        new Error(
          `Virtual MIDI controller '${name}' exited before '${pending.expected}': ${stderr.trim()}`,
        ),
      );
    }
  };
  lines.on("line", (line) => {
    const pending = waiting[0];
    if (pending && line === pending.expected) {
      waiting.shift();
      pending.resolve();
    }
  });
  child.once("exit", failPending);
  child.once("error", failPending);

  /** Waits for the controller to print one acknowledgement line. */
  const expectLine = (expected: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error(`Virtual MIDI controller '${name}' is not running`));
        return;
      }
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for '${expected}' from virtual MIDI controller '${name}': ${stderr.trim()}`,
            ),
          ),
        timeoutMs,
      );
      waiting.push({
        expected,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

  await expectLine(`READY ${name}`, READY_TIMEOUT_MS);

  /** Writes one message line and waits until the controller reports sending it. */
  const send = async (bytes: number[]) => {
    const line = JSON.stringify(bytes);
    const sent = expectLine(`SENT ${line}`, SEND_TIMEOUT_MS);
    child.stdin?.write(`${line}\n`);
    await sent;
  };

  return {
    name,
    send,
    note: (note, on, { channel = 0, velocity = 127 } = {}) =>
      send(
        on
          ? [0x90 | channel, dataByte(note), dataByte(velocity)]
          : [0x80 | channel, dataByte(note), 0],
      ),
    cc: (controller, value, channel = 0) =>
      send([0xb0 | channel, dataByte(controller), dataByte(value)]),
    pitchBend: (value, channel = 0) => {
      const clamped = Math.max(0, Math.min(16_383, Math.round(value)));
      return send([0xe0 | channel, clamped & 0x7f, clamped >> 7]);
    },
    close: async () => {
      child.stdin?.end();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited(child);
      clearTimeout(timeout);
    },
  };
}

/** Waits until the backend has connected to the controller's port and reports it to the UI. */
export async function waitForMidiDevice(
  page: Page,
  midi: VirtualMidi,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            (window as any).appStores.midiDevices.get() as { name: string }[]
          ).map((device) => device.name),
        ),
      { timeout: 20_000 },
    )
    .toContain(midi.name);
}

/**
 * Backend test fixtures plus `virtualMidi`, a virtual MIDI port for each test.
 *
 * The port takes the one name the test's backend is configured to connect to, so parallel
 * tests never receive each other's messages. Tests are skipped where the host cannot open
 * virtual ports.
 */
export const test = backendTest.extend<
  { virtualMidi: VirtualMidi },
  { virtualMidiExecutable: string }
>({
  /** Builds or locates the virtual controller example once per worker. */
  virtualMidiExecutable: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture parameters to use object destructuring.
    async ({}, use) => {
      if (virtualMidiUnavailableReason()) {
        await use("");
        return;
      }
      await use(await ensureExampleExecutable());
    },
    { scope: "worker", timeout: 600_000 },
  ],

  /** Opens this test's virtual MIDI port and closes it afterward, even when the test fails. */
  virtualMidi: async (
    { backendSlot, virtualMidiExecutable },
    use,
    testInfo,
  ) => {
    const unavailable = virtualMidiUnavailableReason();
    testInfo.skip(Boolean(unavailable), unavailable);
    const runRoot = process.env.NIGHTFALL_PLAYWRIGHT_RUN_ROOT?.trim();
    const midi = await openVirtualMidi(
      virtualMidiExecutable,
      backendSlot.midiInputPort,
      runRoot
        ? join(runRoot, `worker-${testInfo.parallelIndex}-virtual-midi.jsonl`)
        : undefined,
    );
    try {
      await use(midi);
    } finally {
      await midi.close();
    }
  },
});
