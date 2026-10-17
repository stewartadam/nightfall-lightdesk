# Clips

{{#include ../../includes/human-review-disclaimer.md}}

Clips provides reusable playback definitions and control slots. Open it from the Command Palette. Use **Add clip** to create an ID and label, then select the clip and open Properties.

## Configure and play

Choose a source kind and an existing source object: a Sequence or an FX variant. Set priority and other playback options in Properties. The source is a reference; renaming a clip does not create a copy of its sequence or effect.

Right-click a clip for **Start Clip**, **Stop Clip**, and **Show Properties**. The State column distinguishes Active from Idle. For sequence playback, Go advances cues; starting and advancing are separate operations.

The controls area accepts drag-and-drop assignments so frequently used clips have dedicated controls. It can also host master controls. Check each control's label before operating it.

Each control's button has a mode, chosen from the arrow next to it and saved with the show:

| Mode | Clip | Master |
|---|---|---|
| **Go** (default) | Starts the clip, or advances a running sequence | Toggles a toggle-mode master |
| **Back** | Steps a running sequence back one cue | Not available |
| **Flash** | While held, plays the clip at full whatever its fader says, starting it if it was idle | While held, pushes the master to full |
| **Swop** | Like Flash, and also takes every other playback out while held | Not available |
| **Toggle** | Starts the clip, or stops it if it is running | Toggles a toggle-mode master |
| **Release** | Stops the running clip | Not available |

Letting go of Flash or Swop returns the clip to its fader level, and stops it again if the flash started it; a flashed master goes back to its earlier level unless it was moved meanwhile. The button lights up while held. When the button is held from several places, such as the screen and a MIDI pad, the flash lasts until the last one lets go, and a device that disconnects lets go of anything it held. Swop takes out everything other playbacks contribute, colour and movement included, so the swopped clip shows on its own; the Programmer and effect editor previews stay live.

A MIDI or OSC button mapped to the control's button follows the same mode, so changing the mode changes what the controller does too. To keep a controller button on Go whatever the mode, map it to **Go control** instead.

Use [Status Display](status-display.md) to inspect running instances and [Layers](layers.md) to see their contribution to fixtures. Clear Programmer before evaluating playback. After changing a clip's source, stop its existing playback and start again to verify the intended definition.
