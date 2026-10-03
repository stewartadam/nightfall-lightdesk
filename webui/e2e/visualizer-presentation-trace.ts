// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";

/** Captures compositor presentation evidence in the isolated test browser, without GPU synchronization. */
export async function startVisualizerPresentationTrace(page: Page) {
  const browser = page.context().browser();
  if (!browser) throw new Error("Presentation tracing requires Chromium");
  const connection = await browser.newBrowserCDPSession();
  try {
    await connection.send("Tracing.start", {
      categories:
        "benchmark,cc,disabled-by-default-devtools.timeline.frame,blink.user_timing" +
        (process.env.NIGHTFALL_VISUALIZER_DETAILED_TRACE === "1"
          ? ",devtools.timeline,v8.execute,disabled-by-default-v8.gc"
          : ""),
      transferMode: "ReturnAsStream",
    });
  } catch (error) {
    await connection.detach();
    throw error;
  }

  /** Ends tracing, reads a bounded artifact, and releases the trace stream and debugger session. */
  return async (): Promise<string> => {
    let stream: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    /** Resolves the pending end request when Chromium has serialized its trace. */
    let onComplete: (event: { stream?: string }) => void = () => {};
    try {
      const completed = new Promise<string>((resolve, reject) => {
        onComplete = (event) => {
          if (event.stream) resolve(event.stream);
          else reject(new Error("Chromium returned no trace stream"));
        };
        connection.once("Tracing.tracingComplete", onComplete);
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for presentation trace")),
          15_000,
        );
      });
      const [, handle] = await Promise.all([
        connection.send("Tracing.end"),
        completed,
      ]);
      stream = handle;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await connection.send("IO.read", {
          handle: stream,
          size: 1024 * 1024,
        });
        const data = Buffer.from(
          chunk.data,
          chunk.base64Encoded ? "base64" : "utf8",
        );
        bytes += data.byteLength;
        if (bytes > 128 * 1024 * 1024)
          throw new Error("Presentation trace exceeded 128 MiB");
        chunks.push(data);
        if (chunk.eof) break;
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      clearTimeout(timeout);
      connection.removeListener("Tracing.tracingComplete", onComplete);
      try {
        if (stream) await connection.send("IO.close", { handle: stream });
      } finally {
        await connection.detach();
      }
    }
  };
}
