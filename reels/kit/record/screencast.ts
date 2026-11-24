// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";

/** One compositor frame saved to disk with the wall-clock time it was shown. */
interface CapturedFrame {
  file: string;
  /** Seconds since the Unix epoch, from the compositor. */
  timestamp: number;
}

/**
 * Records a page through Chrome's screencast and turns the frames into a
 * constant-frame-rate H.264 file. Playwright's built-in video is fixed at
 * 25 fps and heavily compressed; the screencast hands over every frame the
 * compositor draws, in device pixels, so the cursor glide and playhead stay
 * smooth. The compositor only emits frames when something changes, so each
 * frame is held until the next one when the video is assembled.
 */
export class ScreencastRecorder {
  private session: CDPSession | undefined;
  private readonly frames: CapturedFrame[] = [];
  private pending: Promise<unknown>[] = [];
  private startedAt = 0;
  private stoppedAt = 0;

  constructor(
    private readonly page: Page,
    private readonly frameDir: string,
    private readonly size: { width: number; height: number },
  ) {}

  /** Starts capturing and returns the wall-clock start time in seconds. */
  async start(): Promise<number> {
    rmSync(this.frameDir, { force: true, recursive: true });
    mkdirSync(this.frameDir, { recursive: true });
    this.session = await this.page.context().newCDPSession(this.page);
    this.session.on("Page.screencastFrame", (event) => {
      const index = this.frames.length;
      const file = join(
        this.frameDir,
        `frame-${String(index).padStart(6, "0")}.jpg`,
      );
      this.frames.push({ file, timestamp: event.metadata.timestamp ?? 0 });
      writeFileSync(file, Buffer.from(event.data, "base64"));
      // Acknowledge promptly; Chrome stops sending frames until it is acked.
      this.pending.push(
        this.session
          ?.send("Page.screencastFrameAck", { sessionId: event.sessionId })
          .catch(() => undefined) ?? Promise.resolve(),
      );
    });
    this.startedAt = Date.now() / 1000;
    await this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 85,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: 1,
    });
    return this.startedAt;
  }

  /** Stops capturing and returns the wall-clock stop time in seconds. */
  async stop(): Promise<number> {
    this.stoppedAt = Date.now() / 1000;
    await this.session?.send("Page.stopScreencast");
    await Promise.all(this.pending);
    await this.session?.detach();
    this.session = undefined;
    return this.stoppedAt;
  }

  /** Frames captured so far per second of recording, for the run log. */
  averageFps(): number {
    const seconds = this.stoppedAt - this.startedAt;
    return seconds > 0 ? this.frames.length / seconds : 0;
  }

  /**
   * Writes the captured frames to `output` as constant-rate H.264, starting
   * at `from` (wall-clock seconds) so the video's zero lines up with the
   * markers the recording script logged.
   */
  encode(output: string, fps: number, from: number): void {
    const frames = this.frames.filter((frame) => frame.timestamp > 0);
    if (frames.length === 0) throw new Error("No screencast frames captured");
    const lines = ["ffconcat version 1.0"];
    /** Quotes a path for the concat demuxer, which reads `'` as a string delimiter. */
    const entry = (file: string) => `file '${file.replaceAll("'", "'\\''")}'`;
    // Each frame shows from its own swap (never before the recording start)
    // until the next frame's, unclamped, so the video's clock stays the wall
    // clock the markers use; the fps filter resamples it to a constant rate.
    const firstHold = Math.max(0, frames[0].timestamp - from);
    if (firstHold > 0) {
      lines.push(entry(frames[0].file), `duration ${firstHold.toFixed(6)}`);
    }
    frames.forEach((frame, index) => {
      const shownAt = Math.max(frame.timestamp, from);
      const next = Math.max(
        frames[index + 1]?.timestamp ?? this.stoppedAt,
        shownAt,
      );
      lines.push(entry(frame.file), `duration ${(next - shownAt).toFixed(6)}`);
    });
    // The concat demuxer ignores the last entry's duration unless it repeats.
    lines.push(entry(frames[frames.length - 1].file));
    const listFile = join(this.frameDir, "frames.ffconcat");
    writeFileSync(listFile, `${lines.join("\n")}\n`);
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-safe",
        "0",
        "-f",
        "concat",
        "-i",
        listFile,
        "-vf",
        `scale=${this.size.width}:${this.size.height}:flags=lanczos,fps=${fps}`,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "14",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      { stdio: "inherit" },
    );
    if (result.error) {
      throw new Error(
        `Could not run ffmpeg (${result.error.message}); install it, e.g. \`brew install ffmpeg\``,
      );
    }
    if (result.status !== 0) {
      throw new Error(`ffmpeg exited with ${result.status ?? result.signal}`);
    }
    // The frames sit under the renderer's public folder, which every render
    // copies, so drop them once the video exists.
    rmSync(this.frameDir, { force: true, recursive: true });
  }
}
