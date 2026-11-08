# Coming from another console

{{#include ../includes/human-review-disclaimer.md}}

If you've programmed on ETC Eos, grandMA3, Obsidian Onyx, or QLC+, most of what you know carries over. Nightfall uses its own names for some familiar ideas. Use the tables on this page to find the Nightfall name for something you already know, and then read that topic's page for the details.

Console names in these tables follow each vendor's current software. Names can differ between versions and models, so check your console's manual when a term doesn't match. A dash means the console has no feature with that name that matches closely.

## Programming

| Nightfall | Eos | grandMA3 | Onyx | QLC+ |
| --- | --- | --- | --- | --- |
| [Programmer](panels/programmer.md) | Manual data in Live | Programmer | Programmer | Simple Desk |
| [Group](panels/groups.md) | Group | Group | Group | Fixture group |
| [Blueprint](panels/blueprints.md) | Palette or preset | Preset | Preset | Palette (QLC+ 5) |
| [Cue](cues.md) | Cue | Cue | Cue | Scene, or a step in a chaser |
| [Sequence](panels/sequences.md) | Cue list | Sequence | Cuelist | Chaser |
| [Cue part](cues.md#cue-parts) | Part cue | Cue part | — | — |
| Store, `/merge`, `/update`, `/remove` ([Storing and recalling looks](stores.md)) | Record, Record Only, Update | Store, Merge, Update, Remove | Record (Merge, Replace, Remove), Update | Edit a scene |
| [References](panels/references.md) | Referenced data | Preset references | Preset references | — |

A blueprint keeps a reference by default, so changing the blueprint changes every cue that uses it, as a palette does on Eos or a preset does on grandMA3 and Onyx.

## Playback

| Nightfall | Eos | grandMA3 | Onyx | QLC+ |
| --- | --- | --- | --- | --- |
| [Clip](panels/clips.md) | Cue list on a fader | Executor | Playback | Virtual console widget |
| [Fader](panels/clips.md) | Fader | Executor fader | Playback fader | Slider |
| **Flash** and **Swop** button modes ([Clips](panels/clips.md)) | Bump button, Solo | Flash, Swap | Flash | Flash button |
| [Board](panels/boards.md) | Magic sheet | Layout view | Playback button pages | Virtual console |
| Intensity [master](panels/masters.md) | Grandmaster, submaster | Grand master, group master | Grand master, group master | Grand master |
| Speed [master](panels/masters.md) | Rate | Speed master | Chase rate | Speed dial |
| [Show tempo](tempo.md) | Effect BPM (Learn Time) | Speed master BPM | Beat Provider (chases) | Speed dial tap |
| [Macro](panels/macros.md) | Macro | Macro | Macro | Script |
| [Timeline](panels/timelines.md) | Timecode event list | Timecode show | Timecode on a cuelist | Show manager |
| [Layers](panels/layers.md) | Playback priority and HTP/LTP | Executor priority | Playback priority | HTP/LTP |

Nightfall has one show tempo. A speed master has no BPM of its own: it scales how fast playbacks run against that one tempo. Effects and sequences set to **Beats** timing follow the show tempo.

## Tracking and cue behavior

| Nightfall | Eos | grandMA3 | Onyx | QLC+ |
| --- | --- | --- | --- | --- |
| [Tracking](cues.md#tracking) | Tracking | Tracking | Tracking | No tracking |
| Per-cue tracking settings in the **Tracking** column of the [Sequence Editor](panels/sequence-editor.md) | Closest to Cue Only | Closest to Cue Only | Closest to Cue Only | — |
| `block cue 1.5` and `unblock cue 1.5` | Block | Block | Unblock Cuelist (no Block command) | — |
| Lookahead, in the **Lookahead** column of the [Sequence Editor](panels/sequence-editor.md) | Auto Mark | Move in Black | Move in Black | — |
| [Cue triggers](cues.md#cue-triggers): **Follow Previous**, **After Delay**, **At** | Follow, Hang | Trig: Follow, Time | Wait, Follow | Chaser hold and fade |
| [Setup and release](cues.md#setup-and-release) | Release, Off | CueZero, OffCue | Release options | — |

Cue Only on Eos, grandMA3, and Onyx stores a change that the next cue undoes. Nightfall has no single Cue Only action. Instead, each cue can turn off tracking for HTP attributes such as intensity, for LTP attributes, or for effects, so those values don't carry into later cues.

## Effects

| Nightfall | Eos | grandMA3 | Onyx | QLC+ |
| --- | --- | --- | --- | --- |
| [FX](panels/fx-list.md) | Effect | Phaser | FX | EFX, RGB Matrix |
| Step FX ([FX List](panels/fx-list.md)) | Step-based effect | Step phaser | Chase cuelist | Chaser |
| [Color path](color-paths.md) | Color path | — | — | — |
| Flow (experimental) | — | — | — | — |

A flow is an experimental node graph that builds values from inputs such as the show tempo. No other console in this table has a direct match.

## Patch and output

| Nightfall | Eos | grandMA3 | Onyx | QLC+ |
| --- | --- | --- | --- | --- |
| [Patch](panels/patch.md) | Patch | Patch | Patch | Fixture manager |
| [DMX route](dmx-patching.md) | Address, output universe | DMX address, universe | Address, DMX output | Address, universe output |
| [Console DMX](panels/console-dmx.md) | DMX output | DMX Sheet | DMX universes | Universes |
| [Fixture Library](panels/fixture-library.md) (GDTF and Open Fixture Library) | Fixture library | Fixture type library | Fixture library | Fixture definitions |
| [3D Visualizer](panels/3d-visualizer.md) | Augment3d | 3D window | — | 3D View (QLC+ 5) |

## Not in Nightfall yet

These features from other consoles don't exist in Nightfall yet:

- Park, to hold a fixture or attribute at a value whatever playback does.
- MVR import and export of the patch and 3D positions.
- Show control output, to send OSC, MIDI, or network messages to other systems.
- A tracking spreadsheet that shows every cue by fixture and attribute.
- A CIE color picker and gel swatches.
- Pixel mapping from images, gradients, or video.
- Focus points and Flip.
- A time-of-day or sunrise and sunset scheduler.
- A backup server that takes over if the main one fails.

## Related topics

- [Glossary](glossary.md)
- [Your first show](getting-started.md)
- [Basic command syntax](commands.md)

ETC, Eos, Augment3d, grandMA3, Obsidian, Onyx, and QLC+ are trademarks of their respective owners. Nightfall is not affiliated with or endorsed by them.
