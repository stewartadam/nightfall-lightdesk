# Masters

{{#include ../../includes/human-review-disclaimer.md}}

Masters controls intensity or playback speed over a selected scope. Open it from the Command Palette.

Every new show starts with two masters at 100%: **Global Intensity Master** (master 1) scales intensity across the whole rig, and **Global Speed Master** (master 2) scales the speed of everything playing. Edit or delete them like any other master.

Use **New intensity global** for an intensity master across the rig, or choose a group and **New group master** for a subset. **New speed global** creates a speed master for everything playing; select clips and use **New clip speed** to scope it to their instances. At 100% a speed master leaves playback as written, 200% runs twice as fast and 50% half as fast. It scales everything about a playback together: steps, effect cycles, fades, delays and follow times.

Each row shows the master, its mode, level, and enabled state. Change the level to scale the affected output or playback speed. An inhibitive intensity master limits intensity; it does not create a look in an otherwise empty programmer.

Drag a master to a control slot in [Clips](clips.md) for convenient operation. If fixtures are unexpectedly dark or playback is unusually slow, inspect all applicable masters and their enabled states before changing cue programming.

Save the showfile to preserve master definitions and assignments.
