# Launch quantize

{{#include ../includes/human-review-disclaimer.md}}

Launch quantize makes the clip launches an operator presses land on the beat. With it on, a start, Go, or stop waits until the next beat or the next downbeat of the show tempo, then fires. Launches that an engine system runs, such as timeline playback or a macro's statements, never wait.

This page records what launch quantize must do and why. Read it before you change which commands wait, what happens to launches that are waiting, or how clients learn about them.

## Problem

A busking operator fires clips by hand to music. A press a little early or late puts the clip off the beat, and the lag between hearing a beat and pressing a button makes that hard to avoid. Launch quantize holds the press until the beat so the clip starts in time.

## Users and goals

The following table lists who uses launch quantize and what each needs:

| User | Goal |
|------|------|
| Busking operator | Press a clip slightly early and have it start exactly on the next beat or bar. |
| Show programmer | Choose per show whether live launches wait for the beat, the bar, or nothing. |
| Timeline author | Keep timeline playback on its own grid, unaffected by the live quantize setting. |

## Requirements

### Mode

- Launch quantize is one show-wide mode with three values: **Off**, **Beat**, and **Bar**. The showfile saves it with the tempo.
- **Off** fires every launch at once. **Beat** waits for the next beat. **Bar** waits for the next downbeat, using the show's beats per bar.
- A press that lands within a twentieth of a beat after the beat or downbeat fires at once, rather than waiting a whole beat or bar.

### Which launches wait

- Clip starts, Go presses, and stops that a person sends wait: from the web UI, the command line, a board, a keybinding, MIDI, or OSC.
- Timeline and flow playback never wait, so they keep to their own grid.
- Held **Flash** and **Swop** buttons always act at once.
- Macros ignore launch quantize. Starting a macro never waits for the beat, and the clip launches its statements run fire at once. A macro runs its statements one after another, so if each launch waited on its own, `clip 1 go` then `clip 2 go` would land on two different bars.
- A macro's clip launch and a launch the operator already armed for the same clip are independent. The macro's fires at once, and the armed one still fires on its beat, so a macro Go plus an armed Go advances the clip twice.
- Other clip commands, such as Go To, fire at once.

### Waiting launches

- A waiting launch is called armed. Clients show armed clips on their slot buttons and on board buttons for them.
- Pressing the same launch again before its beat disarms it, and neither press fires.
- A stop cancels any start or Go still waiting for the same clips. If those clips aren't running, the stop has nothing left to do and finishes at once instead of waiting.
- **Launch armed clips now**, a toolbar button and a mappable action, fires every armed launch at once.
- Changing the mode doesn't touch launches that are already armed. They still fire on the beat they were armed for, and only later presses follow the new mode. Switching to **Off** doesn't fire or drop them.
- Loading a show drops every armed launch, because launches address clips by ID and the new show reuses those IDs for different clips. Each dropped launch's command fails with `clip.launch_dropped`, so a client waiting on it isn't told the clip ran. A load that is rejected keeps the current show and its armed launches.
- The command that armed a launch finishes when the launch fires, is disarmed, or is dropped.

### Clients

- The engine sends the full list of armed launches, with each clip's action and target beat, whenever it changes.
- A client that resyncs gets the current list. Only that client gets it, not every connected client.

## Out of scope

The following items are deliberately left out:

- A quantize setting per clip, per board, or per button.
- Quantizing a macro's start, or any command other than clip starts, Go presses, and stops.

## In the code

| Concept | Where to look |
|---------|---------------|
| Mode, target beat, and grace window | `crates/tempo/src/lib.rs` |
| Armed launches and which origins wait | `crates/clips/src/launch_quantize.rs` |
| Arming, firing, and **Launch armed clips now** | `crates/clips/src/playback/clip_events.rs` |
| Messages to clients | `crates/clips/src/websocket.rs` |
| Dropping armed launches on show load | `crates/app-runtime/src/systems/showfile_events/load.rs` |
| Macro statement origin | `crates/macros/src/runner.rs` |

## Related topics

- [Macros](macros.md)
- [From command to state change](../engine/command-path.md)
