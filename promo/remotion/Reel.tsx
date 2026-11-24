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
  INTRO_SECONDS,
  type RecordingManifest,
  type ReelEdit,
} from "../shared/edit";

/** Props resolved by `calculateMetadata` from a reel's take and its edit. */
export interface ReelProps extends Record<string, unknown> {
  manifest: RecordingManifest | null;
  edit: ReelEdit | null;
}

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** Seconds the intro card and the screen overlap while one hands over to the other. */
const HANDOFF_SECONDS = 0.5;

/**
 * The Nightfall mark: three faders whose knobs drift with `phase`, so the
 * logo feels alive on the cards without a separate animation asset.
 */
function Logo({ size, phase }: { size: number; phase: number }) {
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

/** Opening card: logo, kicker, title and subtitle, each springing in a beat apart. */
function IntroCard({ edit }: { edit: ReelEdit }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const rise = (delay: number) =>
    spring({
      frame: frame - delay * fps,
      fps,
      config: { damping: 16, mass: 0.7 },
    });
  const leave = interpolate(
    frame,
    [durationInFrames - HANDOFF_SECONDS * fps, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const item = (delay: number) => ({
    opacity: rise(delay) * leave,
    transform: `translateY(${(1 - rise(delay)) * 60}px)`,
  });
  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          fontFamily: FONT,
          color: BRAND.ink,
          gap: 28,
          transform: `scale(${1 + (1 - leave) * 0.08})`,
        }}
      >
        <div style={item(0)}>
          <Logo size={220} phase={frame / fps} />
        </div>
        <div
          style={{
            ...item(0.15),
            color: BRAND.teal,
            fontSize: 44,
            fontWeight: 700,
            letterSpacing: 6,
            textTransform: "uppercase",
          }}
        >
          {edit.intro.kicker}
        </div>
        <div
          style={{
            ...item(0.3),
            fontSize: 168,
            fontWeight: 800,
            letterSpacing: -4,
          }}
        >
          {edit.intro.title}
        </div>
        <div
          style={{
            ...item(0.45),
            fontSize: 54,
            fontWeight: 500,
            opacity: 0.85 * rise(0.45) * leave,
          }}
        >
          {edit.intro.subtitle}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
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
            transformOrigin: "0 0",
            transform: `scale(${sx}, ${sy}) translate(${manifest.width / 2}px, ${manifest.height / 2}px) scale(${camera.scale}) translate(${-camera.centerX}px, ${-camera.centerY}px)`,
          }}
        >
          <OffthreadVideo
            src={staticFile(manifest.video)}
            trimBefore={Math.max(
              0,
              Math.round((edit.trimStart - HANDOFF_SECONDS) * fps),
            )}
            muted
            style={{ width: manifest.width, height: manifest.height }}
          />
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
        paddingBottom: 400,
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
export function Reel({ manifest, edit }: ReelProps) {
  const { fps } = useVideoConfig();
  if (!manifest || !edit)
    return <AbsoluteFill style={{ background: BRAND.night }} />;
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
        <IntroCard edit={edit} />
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
