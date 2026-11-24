# Reel guidance

Follow these rules when you write or change a reel. [README.md](README.md) covers how to record, render and add a reel.

## Captions and titles

Captions and titles follow the repository's [writing style guide](../docs/internal/src/contributing/writing-style.md), plus these rules for short video:

- Write each caption as a plain sentence that says what is happening on screen. Avoid slogan patterns, such as "Your A, B", "count X, count Y", "From A to B", groups of three, and leaning on "every".
- Keep captions low in the frame, so they don't cover the 3D view or the part of the app being shown.
- End each caption after about 5 seconds, so it doesn't linger over later actions.
- Drop captions that only narrate a click, such as "Click Import".
- Use a literal, searchable title that names the feature, such as "GDTF Share support".
- Open on the title card. It is the first frame and the cover image, and shows "New in Nightfall" with the version from the build.
- Close on "Try it in your browser", or on "Download Nightfall" when the browser demo can't show the feature.

## Camera and zooms

A zoom frames an action and then gets out of the way:

- Move the cursor to its target first, then zoom in, wait about 0.5 seconds, and click. The camera never moves during a click.
- Cover a run of clicks in one region with a single zoom, instead of zooming in and out for each.
- Zoom all the way out once a step finishes, such as an import, so the viewer sees the result in the visualizer.
- Don't zoom where the frame would clip a form, dialog or result the viewer needs to read. When in doubt, stay wide.

## Pacing and content

Every second on screen shows something happening:

- Don't hold a static screen. Show the action, such as dragging a file into the drop zone, instead of sitting on "Drop a file".
- Hold each state long enough to see the change, such as at least one full chase cycle at each speed.
- Tune effects to read at phone size. Use high-contrast looks, a slow enough base speed and a clear direction, such as a left-to-right sweep. Pick tempos far enough apart that the change is obvious, such as 120 and 80 BPM.
- Set up the show off camera, and start from a clean stage with no sample fixtures or truss.
- Credit third-party sample files by author in the file name, such as `Midsize w GP (JMLutra).mvr`.

## Recording

Takes need a steady machine and a clean frame:

- Record any reel that shows the 3D visualizer on a machine with a GPU, with nothing else heavy running, such as `rustc`. Run one capture at a time.
- Capture at twice the output size, the default, so zoomed shots stay sharp.
- Hide debug overlays, such as the visualizer's FPS badge.
- Keep the corner dots `take.ts` adds. They stop Chrome's screencast from locking onto the 3D view and skipping frames (see "Screencast lock-in" in the README).
- Fix product bugs a take exposes in the app, in their own pull request, instead of working around them in the reel.
