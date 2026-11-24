<!-- SPDX-License-Identifier: MPL-2.0 -->

<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# Promo reels

Vertical (1080x1920, 60 fps) feature reels for social media, cut from scripted
recordings of the real app and rendered with [Remotion](https://www.remotion.dev).
This folder is its own pnpm workspace, so the app's install, build, checks and
Cargo never touch it.

## Make a reel

```sh
pnpm --dir promo install
pnpm --dir promo run record <reel>   # Playwright take -> promo/out/<reel>/
pnpm --dir promo run render <reel>   # -> promo/out/<reel>.mp4 and <reel>-cover.png
pnpm --dir promo run studio          # preview and tweak every reel's edit
```

`<reel>` is a folder under `reels/`. Set `PROMO_BROWSER` to a Chrome or headless
shell binary to skip Remotion's own browser download.

Every reel opens on its title card, with the app version from `Cargo.toml`
under "New in Nightfall", fully drawn on the first frame. TikTok and Shorts
pick their thumbnail from a frame, so that frame is the title. Upload
`<reel>-cover.png` as the cover where a platform takes a custom one, such as
Instagram.

## Add a reel

Each reel is a folder under `reels/`, named with letters, digits and dashes
only (it doubles as the Remotion composition id), with two files, registered
in `reels/index.ts`:

- `<reel>.record.ts` is a Playwright test that opens the demo with `openDemo`,
  then drives a `Take`: `start()` begins capturing, `glideAndClick()` moves the
  fake cursor and clicks, `mark()` names the moments the edit cuts on (with the
  element to zoom to), and `finish()` writes the take. A feature the browser
  demo hides, such as GDTF Share or MVR import, records against the desktop
  backend instead: name the script `<reel>.desktop.record.ts` and open the app
  with `openDesktop`, which starts from a fresh empty show.
- `edit.ts` exports a `ReelDefinition` whose `buildEdit` turns the take's markers
  into intro copy, captions, zooms and optional music, using `editTools` and
  `assembleEdit` from `shared/edit.ts`.

The renderer lays out every reel the same way: intro card, the take zoomed and
captioned, outro card.

## How it fits together

- `record/` is the recording kit. The take runs through the repository's
  Playwright wrapper against the embedded demo engine and its bundled sample
  show, so every take starts from the same state. A fake cursor
  (`cursor-overlay.ts`) glides along eased, curved paths with a slight
  overshoot and ripples on click; the real click fires when it arrives. Frames
  come from Chrome's screencast (`screencast.ts`) and are resampled to 60 fps.
- `shared/edit.ts` defines the take's manifest, the edit a reel builds from it,
  and the camera that eases between zooms. It knows nothing about the
  renderer, so edits survive a change of video tool.
- `remotion/` lays any edit out as React components, one composition per reel.

## Licence

Remotion is source-available, not open source. It is free for individuals,
non-profits and companies of up to 3 people; larger for-profit teams need a
[company licence](https://www.remotion.dev/license).

## Capture frame rate

Takes average about 34 fps in a cloud container without a GPU: the compositor
only paints changed frames, and software rendering at 1080x1920 is slow. The
reel's own motion (camera, captions, cards) is always 60 fps. Expect a smoother
capture on a machine with a GPU.

The 3D visualizer renders seconds behind the rest of the page in software, so
a reel that shows it (busking, placement, MVR import) needs a take recorded on
a machine with a GPU.
