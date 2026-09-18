# Welcome to Nightfall

{{#include ../includes/human-review-disclaimer.md}}

Nightfall is a lighting controller for building looks, playing cue sequences and effects, and synchronizing lighting with a timeline. Use the 3D Visualizer to work before connecting a lighting rig.

Visit [nightfall.live](https://nightfall.live) for the project and [Downloads](https://nightfall.live/downloads) for available builds. This guide describes the desktop application and its connected web UI. The browser demo runs locally in your browser with a curated show; it does not connect to lighting hardware and is not a substitute for saving a desktop showfile.

Start with [Your first show](getting-started.md), then keep the [panel guide](panels/index.md) nearby. Flows are experimental and are outside the first-release workflow covered here.

## The working model

1. **Patch fixtures** so Nightfall knows their attributes, modes, and addresses.
2. **Select fixtures** and set values in the **Programmer** to build a look.
3. **Store cues** in a **Sequence** to keep those looks and their transition timing.
4. **Create a Clip** to give a sequence or effect playback controls.
5. **Arrange actions on a Timeline** when playback should follow time.
6. **Save the showfile** to preserve your work.

The programmer is live. Its values can continue to affect output after you store a cue. Clear it before checking playback so you see what the stored cue produces.

## Find your way around

Click the top-toolbar Search icon, or press **Ctrl+Shift+P** (**Cmd+Shift+P** on macOS), to open the Command Palette. Search for a panel by the names in this guide. The palette also finds show objects. Contextual editors such as Cue Editor and Timeline open from their respective lists.

Drag panel tabs to rearrange the workspace, group tabs together, or split an area. Some panels begin collapsed along a window edge; open them from the palette to expand them. Reopen a closed panel from the palette. Layout controls let you save and restore arrangements.

Keep **Properties** open beside the panel you are using. It follows the active panel and its selected object; an empty Properties panel often means there is no applicable selection.

Tables commonly offer search, filters, and a column-visibility menu. If an object appears to be missing, clear the search and filters first. Click an editable cell and press Enter or double-click it to edit; confirm the edit with Enter. Row selection, fixture selection, and the active cell serve different purposes, so watch which rows are highlighted before bulk operations.

## Saving and recovery

Use the application menu's **Save Showfile** action. **Open Showfile** lists saved shows and their available revisions and drafts. Saving records the show; saving a layout alone does not save fixture programming.

If startup offers to resume unsaved work, **Load Draft** restores the draft and **Keep Saved** discards it in favor of the saved show. Read the show name and timestamps before choosing. A backup revision can be opened from the showfile picker; use a named save such as `save recovered-show` if you want to preserve the current version too.

For a display that stops updating, first check the connection indicator. Allow a few seconds for a newly opened UI to connect. See [Status Display](panels/status-display.md), [Console](panels/console.md), and [Instrumentation](panels/instrumentation.md) when diagnosing a problem.
