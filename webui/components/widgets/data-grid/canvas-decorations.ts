// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Draws a conflict warning glyph as a left-side cell decoration. */
export function drawConflictWarningIcon(args: {
  ctx: CanvasRenderingContext2D;
  rect: { x: number; y: number; width: number; height: number };
}) {
  const { ctx: canvasCtx, rect } = args;

  canvasCtx.save();
  canvasCtx.font =
    "14px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  canvasCtx.textAlign = "center";
  canvasCtx.textBaseline = "middle";
  canvasCtx.fillText("⚠️", rect.x + 16, rect.y + rect.height / 2);
  canvasCtx.restore();
}

/** Draws a compact play glyph as a left-side cell decoration. */
export function drawActiveCuePlayIcon(args: {
  ctx: CanvasRenderingContext2D;
  rect: { x: number; y: number; width: number; height: number };
}) {
  const { ctx: canvasCtx, rect } = args;
  const iconPath = new Path2D(
    "M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z",
  );
  const size = 12;
  const scale = size / 256;
  const left = rect.x + 1;
  const top = rect.y + (rect.height - size) / 2;

  canvasCtx.save();
  canvasCtx.translate(left, top);
  canvasCtx.scale(scale, scale);
  canvasCtx.fillStyle = "rgba(74, 222, 128, 0.95)";
  canvasCtx.fill(iconPath);
  canvasCtx.restore();
}
