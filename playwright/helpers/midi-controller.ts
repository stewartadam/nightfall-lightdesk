// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";

/** Starts a real OS MIDI source whose lifetime is confined to its owning test. */
export async function startMidiController() {
  const name = `Nightfall test ${randomUUID()}`;
  const child = spawn(
    "cargo",
    [
      "run",
      "--quiet",
      "-p",
      "nightfall-input-midi",
      "--example",
      "controller-test-source",
      "--",
      name,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(60_000) }),
      once(child, "exit").then(() => {
        throw new Error(`MIDI source exited before readiness: ${stderr}`);
      }),
    ]);
    if (line !== "READY") throw new Error(`Unexpected MIDI response: ${line}`);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    lines.close();
  }
  return {
    name,
    /** Sends a note or CC packet through the operating system's MIDI routing. */
    send(status: number, control: number, value: number) {
      child.stdin.write(`${JSON.stringify([status, control, value])}\n`);
    },
    /** Closes stdin so the source releases its native endpoint and exits. */
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit", {
        signal: AbortSignal.timeout(5000),
      });
      child.stdin.end();
      try {
        await exited;
      } finally {
        if (child.exitCode === null) child.kill();
      }
    },
  };
}
