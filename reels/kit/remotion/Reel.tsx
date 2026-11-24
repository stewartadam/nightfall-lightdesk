// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  BRAND,
  type CaptionCue,
  cameraAt,
  cursorAt,
  INTRO_SECONDS,
  type RecordingManifest,
  type ReelEdit,
} from "../shared/edit";

/** Props resolved by `calculateMetadata` from a reel's take and its edit. */
export interface ReelProps extends Record<string, unknown> {
  manifest: RecordingManifest | null;
  edit: ReelEdit | null;
  /** App version shown after the intro kicker; the render script passes it in. */
  version?: string;
}

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** Seconds the intro card and the screen overlap while one hands over to the other. */
const HANDOFF_SECONDS = 0.5;

/**
 * The Nightfall mark: three faders whose knobs drift with `phase`, so the
 * logo feels alive on the cards without a separate animation asset.
 */
function Logo({ size, phase }: { size: number; phase: number }) {
  /** A knob's vertical position: its resting `base` swayed by a sine of `phase`, shifted by `offset` so the three knobs move out of step. */
  const knob = (base: number, offset: number) =>
    base + Math.sin(phase * 2.2 + offset) * 2.2;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill={BRAND.night} />
      {[8, 14.5, 21].map((x) => (
        <rect
          key={x}
          x={x}
          y="8"
          width="3"
          height="16"
          rx="1.5"
          fill={BRAND.ink}
        />
      ))}
      <rect
        x="6.8"
        y={knob(13, 0)}
        width="5.4"
        height="4"
        rx="2"
        fill={BRAND.violet}
      />
      <rect
        x="13.3"
        y={knob(10.5, 2)}
        width="5.4"
        height="4"
        rx="2"
        fill={BRAND.teal}
      />
      <rect
        x="19.8"
        y={knob(16.5, 4)}
        width="5.4"
        height="4"
        rx="2"
        fill={BRAND.amber}
      />
    </svg>
  );
}

/** Soft violet and teal glows behind the cards. */
function Backdrop() {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 90) * 40;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(900px 900px at ${30 + drift / 20}% 28%, ${BRAND.violet}55, transparent 70%),
          radial-gradient(800px 800px at 75% ${78 - drift / 30}%, ${BRAND.teal}40, transparent 70%),
          ${BRAND.night}`,
      }}
    />
  );
}

/**
 * Opening card: logo, kicker (with the app version), title and subtitle. It is
 * fully composed from the first frame, because TikTok and Shorts can only use
 * a frame of the video as the cover; it drifts gently closer, then lifts away.
 */
function IntroCard({ edit, version }: { edit: ReelEdit; version?: string }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const leave = interpolate(
    frame,
    [durationInFrames - HANDOFF_SECONDS * fps, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const drift = interpolate(frame, [0, durationInFrames], [1, 1.04]);
  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          padding: "0 70px",
          textAlign: "center",
          fontFamily: FONT,
          color: BRAND.ink,
          gap: 28,
          opacity: leave,
          transform: `scale(${drift + (1 - leave) * 0.08})`,
        }}
      >
        <Logo size={220} phase={frame / fps} />
        <div
          style={{
            color: BRAND.teal,
            fontSize: 44,
            fontWeight: 700,
            letterSpacing: 6,
            textTransform: "uppercase",
          }}
        >
          {version ? `${edit.intro.kicker} ${version}` : edit.intro.kicker}
        </div>
        <div
          style={{
            fontSize: 150,
            fontWeight: 800,
            letterSpacing: -4,
            lineHeight: 1.02,
          }}
        >
          {edit.intro.title}
        </div>
        <div
          style={{
            fontSize: 54,
            fontWeight: 500,
            opacity: 0.85,
          }}
        >
          {edit.intro.subtitle}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** Seconds the arrow takes to press in and spring back on a click. */
const PRESS_SECONDS = 0.26;
/** Seconds a click ripple takes to spread and fade. */
const RIPPLE_SECONDS = 0.52;

/**
 * The fake cursor at recording time `t`, in recording pixels: a white arrow
 * that presses in on each click, over a ripple spreading from the click. The
 * take only logs the cursor (see `CursorLog`), so this is the only place it
 * is drawn.
 */
function Cursor({ manifest, t }: { manifest: RecordingManifest; t: number }) {
  const tip = cursorAt(manifest.cursor, t);
  if (!tip) return null;
  const px = manifest.scale;
  const recent = manifest.cursor.clicks.filter(
    (click) => click.t <= t && t - click.t < RIPPLE_SECONDS,
  );
  const lastPress = recent.at(-1);
  const pressAge = lastPress ? t - lastPress.t : Number.POSITIVE_INFINITY;
  const press =
    pressAge < PRESS_SECONDS
      ? interpolate(
          pressAge,
          [0, PRESS_SECONDS * 0.35, PRESS_SECONDS],
          [1, 0.82, 1],
          {
            easing: Easing.out(Easing.ease),
          },
        )
      : 1;
  return (
    <>
      {recent.map((click) => {
        const amount = Easing.bezier(
          0.2,
          0.7,
          0.3,
          1,
        )((t - click.t) / RIPPLE_SECONDS);
        const size = 44 * px;
        return (
          <div
            key={click.t}
            style={{
              position: "absolute",
              left: click.x - size / 2,
              top: click.y - size / 2,
              width: size,
              height: size,
              borderRadius: "50%",
              border: `${3 * px}px solid rgba(255,255,255,.95)`,
              background: "rgba(120,170,255,.35)",
              boxShadow: `0 0 ${18 * px}px rgba(120,170,255,.6)`,
              boxSizing: "border-box",
              opacity: 1 - amount,
              transform: `scale(${0.35 + 1.15 * amount})`,
            }}
          />
        );
      })}
      <svg
        width={30 * px}
        height={30 * px}
        viewBox="0 0 24 24"
        style={{
          position: "absolute",
          // The arrow tip sits 5 by 3 CSS pixels in from the graphic's corner.
          left: tip.x - 5 * px,
          top: tip.y - 3 * px,
          overflow: "visible",
          transformOrigin: `${5 * px}px ${3 * px}px`,
          transform: `scale(${press})`,
          filter: `drop-shadow(0 ${3 * px}px ${6 * px}px rgba(0,0,0,.45))`,
        }}
      >
        <path
          d="M4 2.5 L4 19.5 L8.6 15.4 L11.7 22 L14.6 20.7 L11.6 14.3 L17.8 14.3 Z"
          fill="#fff"
          stroke="#111"
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}

/**
 * The screen recording, framed by the shared camera. It grows from a rounded
 * card to full bleed as the intro hands over, then follows the zoom cues.
 */
function Screen({
  edit,
  manifest,
}: {
  edit: ReelEdit;
  manifest: RecordingManifest;
}) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const reelSeconds = INTRO_SECONDS - HANDOFF_SECONDS + frame / fps;
  const camera = cameraAt(reelSeconds, edit, manifest);
  const enter = spring({ frame, fps, config: { damping: 20, mass: 0.9 } });
  const cardScale = 0.82 + 0.18 * enter;
  const radius = (1 - enter) * 48;
  const sx = width / manifest.width;
  /** First recording frame the screen shows, so the cursor reads the same moment as the video. */
  const videoFrom = Math.max(
    0,
    Math.round((edit.trimStart - HANDOFF_SECONDS) * fps),
  );
  const sy = height / manifest.height;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width,
          height,
          overflow: "hidden",
          borderRadius: radius,
          transform: `scale(${cardScale})`,
          opacity: enter,
          boxShadow: "0 40px 120px rgba(0,0,0,.6)",
        }}
      >
        <div
          style={{
            width: manifest.width,
            height: manifest.height,
            position: "relative",
            transformOrigin: "0 0",
            transform: `scale(${sx}, ${sy}) translate(${manifest.width / 2}px, ${manifest.height / 2}px) scale(${camera.scale}) translate(${-camera.centerX}px, ${-camera.centerY}px)`,
          }}
        >
          <OffthreadVideo
            src={staticFile(manifest.video)}
            trimBefore={videoFrom}
            muted
            style={{ width: manifest.width, height: manifest.height }}
          />
          <Cursor manifest={manifest} t={(videoFrom + frame) / fps} />
        </div>
      </div>
    </AbsoluteFill>
  );
}

/** One caption pill near the top safe area: pops in with a spring and fades out. */
function Caption({ cue }: { cue: CaptionCue }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.6 } });
  const out = interpolate(
    frame,
    [durationInFrames - 0.25 * fps, durationInFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: cue.placement === "top" ? "flex-start" : "flex-end",
        paddingTop: 230,
        // Low in the frame, below the 3D view and the app's panels, just above the status bar.
        paddingBottom: 150,
      }}
    >
      <div
        style={{
          maxWidth: 900,
          padding: "26px 44px",
          borderRadius: 36,
          background: "rgba(11,16,32,.86)",
          border: `3px solid ${BRAND.violet}`,
          boxShadow: `0 18px 60px rgba(0,0,0,.5), 0 0 40px ${BRAND.violet}55`,
          color: BRAND.ink,
          fontFamily: FONT,
          fontSize: 58,
          fontWeight: 750,
          lineHeight: 1.15,
          textAlign: "center",
          opacity: pop * out,
          transform: `translateY(${(1 - pop) * (cue.placement === "top" ? -40 : 40)}px) scale(${0.9 + 0.1 * pop})`,
        }}
      >
        {cue.text}
      </div>
    </AbsoluteFill>
  );
}

/** Closing card with the call to action. */
function OutroCard({ edit }: { edit: ReelEdit }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 0.4 * fps], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  /** Spring from 0 to 1 that starts `delay` seconds into the card, so each line of text rises in turn. */
  const rise = (delay: number) =>
    spring({
      frame: frame - delay * fps,
      fps,
      config: { damping: 16, mass: 0.7 },
    });
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <Backdrop />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          gap: 34,
          fontFamily: FONT,
          color: BRAND.ink,
        }}
      >
        <div style={{ transform: `scale(${rise(0.05)})` }}>
          <Logo size={180} phase={frame / fps} />
        </div>
        <div
          style={{
            fontSize: 96,
            fontWeight: 800,
            textAlign: "center",
            lineHeight: 1.05,
            opacity: rise(0.2),
          }}
        >
          {edit.outro.title}
        </div>
        <div style={{ fontSize: 50, opacity: 0.8 * rise(0.35) }}>
          {edit.outro.subtitle}
        </div>
        <div
          style={{
            marginTop: 20,
            padding: "22px 56px",
            borderRadius: 999,
            background: `linear-gradient(90deg, ${BRAND.violet}, ${BRAND.teal})`,
            color: BRAND.night,
            fontSize: 62,
            fontWeight: 800,
            transform: `scale(${rise(0.5)})`,
          }}
        >
          {edit.outro.url}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/**
 * The music under the recording, faded in at its start and out over the last
 * second of the reel.
 */
function Soundtrack({
  src,
  music,
  totalSeconds,
}: {
  src: string;
  music: NonNullable<ReelEdit["music"]>;
  totalSeconds: number;
}) {
  const { fps } = useVideoConfig();
  /** Converts seconds to the nearest whole frame at the composition's frame rate. */
  const frames = (seconds: number) => Math.round(seconds * fps);
  const length = frames(totalSeconds - music.start);
  // Too short to fade; interpolate needs strictly increasing frames.
  if (length < 4) return null;
  // Shorten the fades for music that only plays briefly, so the ramps never cross.
  const fadeIn = Math.max(1, Math.min(frames(0.08), Math.floor(length / 4)));
  const fadeOut = Math.min(frames(1.2), Math.floor(length / 2));
  return (
    <Audio
      src={staticFile(src)}
      trimBefore={frames(music.from)}
      volume={(frame) =>
        interpolate(
          frame,
          [0, fadeIn, length - fadeOut, length],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
      }
    />
  );
}

/**
 * Any reel: intro card, the take zoomed and captioned by its edit, outro card,
 * and the take's music when the edit places it.
 */
export function Reel({ manifest, edit, version }: ReelProps) {
  const { fps } = useVideoConfig();
  if (!manifest || !edit)
    return <AbsoluteFill style={{ background: BRAND.night }} />;
  /** Converts seconds to the nearest whole frame at the composition's frame rate. */
  const frames = (seconds: number) => Math.round(seconds * fps);
  const screenFrom = frames(INTRO_SECONDS - HANDOFF_SECONDS);
  const outroFrom = frames(INTRO_SECONDS + edit.screenSeconds);
  return (
    <AbsoluteFill style={{ background: BRAND.night }}>
      <Sequence
        from={screenFrom}
        durationInFrames={outroFrom - screenFrom + frames(0.4)}
        name="Screen"
      >
        <Screen edit={edit} manifest={manifest} />
      </Sequence>
      <Sequence durationInFrames={frames(INTRO_SECONDS)} name="Intro">
        <IntroCard edit={edit} version={version} />
      </Sequence>
      {edit.captions.map((cue) => (
        <Sequence
          key={`${cue.start}-${cue.text}`}
          from={frames(cue.start)}
          durationInFrames={Math.max(1, frames(cue.end - cue.start))}
          name={`Caption: ${cue.text}`}
        >
          <Caption cue={cue} />
        </Sequence>
      ))}
      <Sequence from={outroFrom} name="Outro">
        <OutroCard edit={edit} />
      </Sequence>
      {manifest.soundtrack && edit.music && (
        <Sequence from={frames(edit.music.start)} name="Soundtrack">
          <Soundtrack
            src={manifest.soundtrack}
            music={edit.music}
            totalSeconds={edit.totalSeconds}
          />
        </Sequence>
      )}
    </AbsoluteFill>
  );
}
