<!-- SPDX-License-Identifier: MPL-2.0 -->

<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# Reels

Vertical (1080x1920, 60 fps) feature reels for social media, cut from scripted
recordings of the real app and rendered with [Remotion](https://www.remotion.dev).
This folder is its own pnpm workspace, so the app's install, build, checks and
Cargo never touch it.

## Make a reel

```sh
pnpm --dir reels install
pnpm --dir reels run record <reel>   # Playwright take -> reels/out/<reel>/
pnpm --dir reels run render <reel>   # -> reels/out/<reel>.mp4 and <reel>-cover.png
pnpm --dir reels run studio          # preview and tweak every reel's edit
```

`<reel>` is a reel's folder beside `kit/`. Set `REELS_BROWSER` to a Chrome or headless
shell binary to skip Remotion's own browser download.

Every reel opens on its title card, with the app version from `Cargo.toml`
under "New in Nightfall", fully drawn on the first frame. TikTok and Shorts
pick their thumbnail from a frame, so that frame is the title. Upload
`<reel>-cover.png` as the cover where a platform takes a custom one, such as
Instagram.

## Add a reel

Each reel is a folder beside `kit/`, named with letters, digits and dashes
only (it doubles as the Remotion composition id), with two files, registered
in `index.ts`:

- `<reel>.record.ts` is a Playwright test that opens the demo with `openDemo`,
  then drives a `Take`: `start()` begins capturing, `glideAndClick()` moves the
  fake cursor and clicks, `mark()` names the moments the edit cuts on (with the
  element to zoom to), and `finish()` writes the take. A feature the browser
  demo hides, such as GDTF Share or MVR import, records against the desktop
  backend instead: name the script `<reel>.desktop.record.ts` and open the app
  with `openDesktop`, which starts from a fresh empty show.
- `edit.ts` exports a `ReelDefinition` whose `buildEdit` turns the take's markers
  into intro copy, captions, zooms and optional music, using `editTools` and
  `assembleEdit` from `kit/shared/edit.ts`.

The renderer lays out every reel the same way: intro card, the take zoomed and
captioned, outro card.

## How it fits together

- `kit/record/` is the recording kit. The take runs through the repository's
  Playwright wrapper against the embedded demo engine and its bundled sample
  show, so every take starts from the same state. A fake cursor
  (`cursor-overlay.ts`) glides along eased, curved paths with a slight
  overshoot, and the real click fires when it arrives. The page never paints
  the cursor: it logs the cursor's path and clicks into the manifest, and the
  renderer draws the arrow and click ripples from that log, sharp at any zoom
  and restylable without a new take. Frames come from Chrome's screencast
  (`screencast.ts`) and are resampled to 60 fps. See "Screencast lock-in"
  below for the corner dots every take adds.
- `kit/shared/edit.ts` defines the take's manifest, the edit a reel builds from it,
  and the camera that eases between zooms. It knows nothing about the
  renderer, so edits survive a change of video tool.
- `kit/remotion/` lays any edit out as React components, one composition per reel.

## Licence

Remotion is source-available, not open source. It is free for individuals,
non-profits and companies of up to 3 people; larger for-profit teams need a
[company licence](https://www.remotion.dev/license).

## Screencast lock-in

Chrome's screencast decides which compositor frames to capture with an
animated-content sampler
([`animated_content_sampler.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/capture/content/animated_content_sampler.cc)).
When one rectangle makes up more than two thirds of the changed pixels for
about a second, the sampler locks onto it as animated content. After that it
captures only frames whose changed area is exactly that rectangle. In a reel,
the 3D view is that rectangle. Any other change on the page, such as a button's
80 ms colour fade, a dialog opening or a cursor drawn in the page, makes the
changed area bigger, so Chrome skips those frames. The take freezes until the
change ends, or for 0.25 s when it outlasts the sampler's "animation ended"
threshold. The screencast API has no option to turn the sampler off.

To stop the lock-in, `take.ts` adds two 1 px, almost transparent dots in
opposite corners of the page (`installDamageJitter`). On each animation frame
one of them changes colour, alternating corners. The changed area then
alternates between two rectangles, neither one wins two thirds of the pixels,
and Chrome captures every frame. The dots are too faint to see in the video.

Keep the dots unless the screencast changes. If a take still freezes after a
click, look for gaps in the frame times, for example with ffmpeg's
`mpdecimate` filter on `out/<reel>/recording.mp4`.

## Capture frame rate

Takes average about 34 fps in a cloud container without a GPU: the compositor
only paints changed frames, and software rendering at 1080x1920 is slow. The
reel's own motion (camera, captions, cards) is always 60 fps. Expect a smoother
capture on a machine with a GPU.

Without a GPU, Chromium's SwiftShader fallback draws the 3D visualizer seconds
behind the rest of the page, so lights react long after the click. For a reel
that shows it, render with Mesa's llvmpipe instead (see "Playwright" in
`CONTRIBUTING.md`) and lower the visualizer's quality:

```sh
NIGHTFALL_PLAYWRIGHT_CHROMIUM_ARGS="--use-angle=gl-egl --ignore-gpu-blocklist" \
REELS_VISUALIZER_QUALITY=low pnpm --dir reels run record <reel>
```
