// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Converts a continuous stream of planar samples from one sample rate to another with
 * cubic interpolation, carrying state across blocks. Resampling the stream as a whole,
 * instead of letting each scheduled buffer resample on its own, keeps block boundaries
 * free of interpolation clicks and lets blocks start exactly on output sample frames.
 */
export class StreamResampler {
  private pending: Float32Array[] | null = null;
  // Position of the next output sample from the start of `pending`, counted in
  // 1/outputRate input samples. Integer arithmetic keeps it exact over hours of audio.
  private position: number;

  /** Create a resampler from `inputRate` to `outputRate` for `channelCount` channels. */
  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
    private readonly channelCount: number,
  ) {
    this.position = outputRate;
  }

  /** Whether samples pass through unchanged because the rates match. */
  get passthrough(): boolean {
    return this.inputRate === this.outputRate;
  }

  /**
   * Add input samples and return every output sample they complete. Output lags input
   * by two samples, which `flush` releases at the end of the stream.
   */
  push(input: Float32Array[]): Float32Array[] {
    if (this.passthrough) return input;
    this.append(input);
    return this.emit(false);
  }

  /** Release the samples still held back, holding the last input sample past the end. */
  flush(): Float32Array[] {
    if (this.passthrough || !this.pending) return this.empty();
    const output = this.emit(true);
    this.pending = null;
    this.position = this.outputRate;
    return output;
  }

  /** Append input to the held samples; the first block repeats its first sample as history. */
  private append(input: Float32Array[]): void {
    const length = input[0]?.length ?? 0;
    if (length === 0) return;
    const held = this.pending;
    this.pending = input.map((channel, index) => {
      const previous = held?.[index] ?? channel.subarray(0, 1);
      const joined = new Float32Array(previous.length + length);
      joined.set(previous);
      joined.set(channel, previous.length);
      return joined;
    });
  }

  /**
   * Interpolate every output sample whose neighbours are available, then drop input no
   * longer needed. At the end of the stream, missing neighbours repeat the last sample.
   */
  private emit(final: boolean): Float32Array[] {
    const pending = this.pending;
    if (!pending) return this.empty();
    const length = pending[0].length;
    const { inputRate, outputRate } = this;
    const limit = (final ? length : length - 2) * outputRate;
    const count = Math.max(0, Math.ceil((limit - this.position) / inputRate));
    const output = pending.map(() => new Float32Array(count));
    const last = length - 1;
    for (let channel = 0; channel < pending.length; channel += 1) {
      const input = pending[channel];
      const out = output[channel];
      let position = this.position;
      for (let index = 0; index < count; index += 1) {
        const whole = Math.floor(position / outputRate);
        const t = (position - whole * outputRate) / outputRate;
        const xm1 = input[whole - 1];
        const x0 = input[whole];
        const x1 = input[Math.min(whole + 1, last)];
        const x2 = input[Math.min(whole + 2, last)];
        out[index] =
          x0 +
          0.5 *
            t *
            (x1 -
              xm1 +
              t *
                (2 * xm1 -
                  5 * x0 +
                  4 * x1 -
                  x2 +
                  t * (3 * (x0 - x1) + x2 - xm1)));
        position += inputRate;
      }
    }
    this.position += count * inputRate;
    const drop = Math.max(0, Math.floor(this.position / outputRate) - 1);
    if (drop > 0) {
      this.pending = pending.map((channel) => channel.slice(drop));
      this.position -= drop * outputRate;
    }
    return output;
  }

  /** An empty block with the stream's channel count. */
  private empty(): Float32Array[] {
    return Array.from({ length: this.channelCount }, () => new Float32Array(0));
  }
}
