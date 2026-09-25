// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Keeps one in-flight update and one replaceable latest snapshot for a busy renderer. */
export class LatestFrameMailbox<T extends object> {
  private pending: T | undefined;
  private inFlight = false;
  private disposed = false;

  /** Uses the receiver's acknowledgement to bound messages without blocking animation. */
  constructor(
    private readonly send: (value: T) => Promise<unknown>,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Lets polling producers defer expensive snapshot construction until the receiver has capacity. */
  get busy(): boolean {
    return this.inFlight;
  }

  /** Replaces any unsent state; intermediate lighting frames have no replay value. */
  publish(value: T): void {
    if (this.disposed) return;
    this.pending = value;
    this.flush();
  }

  /** Drops unsent state when pausing so resume can sample the current show state. */
  clear(): void {
    this.pending = undefined;
  }

  /** Prevents late acknowledgements from sending work after worker ownership ends. */
  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  /** Sends at most one snapshot until the worker acknowledges the previous one. */
  private flush(): void {
    if (this.disposed || this.inFlight || this.pending === undefined) return;
    const value = this.pending;
    this.pending = undefined;
    this.inFlight = true;
    void this.deliver(value);
  }

  /** Releases capacity after either a synchronous serialization error or an async acknowledgement. */
  private async deliver(value: T): Promise<void> {
    try {
      await this.send(value);
    } catch (error) {
      if (!this.disposed) this.onError(error);
    } finally {
      this.inFlight = false;
      this.flush();
    }
  }
}
