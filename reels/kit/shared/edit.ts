// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * What every promo reel shares: canvas size, brand colors, the recording
 * manifest a take writes, the edit a reel builds from it, and the camera that
 * follows the edit's zooms. None of it depends on the renderer, so a reel's
 * edit carries over if the video tool changes.
 */

/** Output canvas for vertical social video (Reels, Shorts, TikTok). */
export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const REEL_FPS = 60;

/** Card lengths around the screen recording, in seconds. */
export const INTRO_SECONDS = 2.2;
export const OUTRO_SECONDS = 2.8;

/** Nightfall logo palette (webui/public/logo.svg). */
export const BRAND = {
  night: "#0B1020",
  ink: "#E6E8FF",
  violet: "#7C5CFF",
  teal: "#31D0AA",
  amber: "#FFB020",
} as const;

/** Rectangle in recording pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One moment the recording script flagged, optionally with the element it acted on. */
export interface RecordingMarker {
  name: string;
  /** Seconds from the first recorded frame. */
  t: number;
  rect?: Rect;
  /** Marker-specific number, such as the timeline position when playback started. */
  value?: number;
}

/** Where the fake cursor's tip was at one moment, in recording seconds and pixels. */
export interface CursorPoint {
  t: number;
  x: number;
  y: number;
}

/**
 * The fake cursor's path and clicks during a take. The page never paints the
 * cursor, so it stays sharp when the camera zooms, and the renderer draws
 * it from this log.
 */
export interface CursorLog {
  /** Positions in time order, one per animation frame while the cursor moves. */
  points: CursorPoint[];
  /** Clicks in time order, where the cursor was when each happened. */
  clicks: CursorPoint[];
}

/**
 * Written by a reel's Playwright take as `out/<reel>/recording.json`. Media
 * paths are relative to `out/`, which the renderer serves as its public folder.
 */
export interface RecordingManifest {
  video: string;
  /** Music the reel can lay under the recording, when the take has any. */
  soundtrack?: string;
  width: number;
  height: number;
  /** Recording pixels per CSS pixel of the page, for drawing page-sized overlays such as the cursor. */
  scale: number;
  fps: number;
  durationSeconds: number;
  markers: RecordingMarker[];
  /** The fake cursor for the renderer to draw over the recording. */
  cursor: CursorLog;
}

/** A caption shown over the recording, in seconds of reel time. */
export interface CaptionCue {
  start: number;
  end: number;
  text: string;
  /** Screen edge the caption sits on, chosen to stay clear of the current zoom. */
  placement: "top" | "bottom";
}

/** A push-in on part of the recording, in seconds of reel time. */
export interface ZoomCue {
  start: number;
  end: number;
  /** Recording-pixel point the zoom centers on. */
  focusX: number;
  focusY: number;
  scale: number;
}

/** Copy for the intro card. */
export interface IntroCopy {
  kicker: string;
  title: string;
  subtitle: string;
}

/** Copy for the outro card. */
export interface OutroCopy {
  title: string;
  subtitle: string;
  url: string;
}

/** The call to action most reels close on. */
export const STANDARD_OUTRO: OutroCopy = {
  title: "Try it in your browser",
  subtitle: "Free and open source",
  url: "nightfall.live",
};

/** The call to action for features only the desktop app has, such as GDTF Share and MVR import. */
export const DESKTOP_OUTRO: OutroCopy = {
  title: "Download Nightfall",
  subtitle: "Free and open source",
  url: "nightfall.live",
};

/** Everything a renderer needs to lay out a reel. */
export interface ReelEdit {
  intro: IntroCopy;
  outro: OutroCopy;
  /** Seconds into the recording where the reel's screen segment starts and ends. */
  trimStart: number;
  trimEnd: number;
  /** Length of the screen segment, `trimEnd - trimStart`. */
  screenSeconds: number;
  totalSeconds: number;
  captions: CaptionCue[];
  zooms: ZoomCue[];
  /** Soundtrack placement: reel second it starts and the source second it starts from. */
  music?: { start: number; from: number };
}

/**
 * One promo video: a Remotion composition id (also its folder under `reels/`
 * and `out/`) and the function that cuts its take into an edit.
 */
export interface ReelDefinition {
  id: string;
  buildEdit(manifest: RecordingManifest): ReelEdit;
}

/** Seconds each camera move takes. */
const CAMERA_RAMP_SECONDS = 0.6;
/** Seconds a zoom is settled before the moment it frames, so a click never lands mid-move. */
const ARRIVE_LEAD_SECONDS = 0.3;
/** Shortest a zoom may hold, so the camera doesn't dart in and straight back out. */
const MIN_ZOOM_SECONDS = 1.6;
/** Shortest wide shot between two zooms; anything shorter pans between them instead. */
const MIN_WIDE_SECONDS = 1.5;

/** Largest scale at which all of `rect` stays in frame, with a margin around it. */
function fitScaleFor(rect: Rect, manifest: RecordingManifest): number {
  return Math.min(
    (manifest.width * 0.9) / rect.width,
    (manifest.height * 0.9) / rect.height,
  );
}

/** Below this, a zoom barely changes the frame, so it is dropped rather than shown. */
const MIN_ZOOM_SCALE = 1.15;

/**
 * Helpers for building an edit from a take whose screen segment starts at the
 * `trimMarker` marker. Edits express everything in reel seconds (the intro
 * card starts at zero), so renderers only convert to frames.
 */
export function editTools(manifest: RecordingManifest, trimMarker: string) {
  /** Finds a marker by name, failing loudly so a renamed step can't silently drop a cue. */
  const marker = (name: string): RecordingMarker => {
    const found = manifest.markers.find((entry) => entry.name === name);
    if (!found) {
      throw new Error(`Recording manifest has no "${name}" marker`);
    }
    return found;
  };
  const trimStart = marker(trimMarker).t;
  /** Converts recording seconds to reel seconds. */
  const reel = (t: number) => INTRO_SECONDS + (t - trimStart);
  return {
    marker,
    reel,
    trimStart,
    /**
     * Zoom that centers on `rect`, at `scale` or fitted to its width, and is
     * fully in by recording time `arrive`, then eases back out from `leave`.
     * Pass the click's time as `arrive` so the camera settles before the
     * click rather than moving during it. The scale is capped so all of
     * `rect` stays in frame. Returns no cue when the marker had no element
     * box, or when the zoom that fits would barely change the frame.
     */
    focusOn(
      arrive: number,
      leave: number,
      rect: Rect | undefined,
      scale?: number,
    ): ZoomCue[] {
      if (!rect) return [];
      const fitted = Math.min(scale ?? 2.1, fitScaleFor(rect, manifest));
      if (fitted < MIN_ZOOM_SCALE) return [];
      return [
        {
          start: reel(arrive) - CAMERA_RAMP_SECONDS - ARRIVE_LEAD_SECONDS,
          end: reel(leave),
          focusX: rect.x + rect.width / 2,
          focusY: rect.y + rect.height / 2,
          scale: fitted,
        },
      ];
    },
  };
}

/**
 * Smooths a reel's zooms so the camera never pumps: each zoom holds for at
 * least {@link MIN_ZOOM_SECONDS}, overlapping zooms hand over in order, and
 * when the next zoom starts less than {@link MIN_WIDE_SECONDS} after one ends,
 * the camera pans straight from one to the other instead of pulling out and
 * pushing back in.
 */
export function smoothZooms(zooms: ZoomCue[]): ZoomCue[] {
  const sorted = [...zooms]
    .sort((a, b) => a.start - b.start)
    .map((cue) => ({
      ...cue,
      end: Math.max(cue.end, cue.start + MIN_ZOOM_SECONDS),
    }));
  return sorted.map((cue, index) => {
    const next = sorted[index + 1];
    if (next && next.start - cue.end < MIN_WIDE_SECONDS) {
      return { ...cue, end: next.start };
    }
    return cue;
  });
}

/**
 * Completes an edit: smooths its zooms (see {@link smoothZooms}) and derives
 * the segment and total lengths from its trim.
 */
export function assembleEdit(
  edit: Omit<ReelEdit, "screenSeconds" | "totalSeconds">,
): ReelEdit {
  const screenSeconds = edit.trimEnd - edit.trimStart;
  return {
    ...edit,
    zooms: smoothZooms(edit.zooms),
    screenSeconds,
    totalSeconds: INTRO_SECONDS + screenSeconds + OUTRO_SECONDS,
  };
}

/** Camera framing: zoom factor and the recording-pixel point at the canvas center. */
export interface Camera {
  scale: number;
  centerX: number;
  centerY: number;
}

/** Smooth ease-in-out on [0, 1]. */
function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Framing a cue asks for, clamped so the zoomed frame never shows past the recording edge. */
function cueCamera(
  cue: ZoomCue | undefined,
  manifest: RecordingManifest,
): Camera {
  if (!cue) {
    return {
      scale: 1,
      centerX: manifest.width / 2,
      centerY: manifest.height / 2,
    };
  }
  const halfW = manifest.width / (2 * cue.scale);
  const halfH = manifest.height / (2 * cue.scale);
  return {
    scale: cue.scale,
    centerX: Math.min(manifest.width - halfW, Math.max(halfW, cue.focusX)),
    centerY: Math.min(manifest.height - halfH, Math.max(halfH, cue.focusY)),
  };
}

/**
 * Camera for a reel time. Each zoom cue holds a framing; at every cue
 * boundary the camera eases from wherever it was to the new framing, so
 * back-to-back zooms pan straight across instead of pulling out in between.
 */
export function cameraAt(
  t: number,
  edit: ReelEdit,
  manifest: RecordingManifest,
): Camera {
  const boundaries = edit.zooms
    .flatMap((cue) => [cue.start, cue.end])
    .filter((boundary) => boundary <= t)
    .sort((a, b) => a - b);
  const target = cueCamera(
    edit.zooms.find((cue) => t >= cue.start && t < cue.end),
    manifest,
  );
  const boundary = boundaries.at(-1);
  if (boundary === undefined || t - boundary >= CAMERA_RAMP_SECONDS) {
    return target;
  }
  const from = cameraAt(boundary - 1e-6, edit, manifest);
  const amount = easeInOutCubic((t - boundary) / CAMERA_RAMP_SECONDS);
  return {
    scale: from.scale + (target.scale - from.scale) * amount,
    centerX: from.centerX + (target.centerX - from.centerX) * amount,
    centerY: from.centerY + (target.centerY - from.centerY) * amount,
  };
}

/**
 * Where the cursor's tip is at recording time `t`, interpolated between the
 * logged positions and held at the first and last ones outside them. Returns
 * nothing for a take without a cursor.
 */
export function cursorAt(
  log: CursorLog,
  t: number,
): { x: number; y: number } | undefined {
  const { points } = log;
  if (points.length === 0) return undefined;
  let low = 0;
  let high = points.length - 1;
  if (t <= points[low].t) return points[low];
  if (t >= points[high].t) return points[high];
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle].t <= t) low = middle;
    else high = middle;
  }
  const a = points[low];
  const b = points[high];
  const amount = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount };
}
