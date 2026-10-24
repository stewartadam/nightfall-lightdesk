# Glossary

{{#include ../includes/human-review-disclaimer.md}}

| Term | Meaning |
| --- | --- |
| Attribute | A controllable fixture property, such as intensity, pan, or red. |
| Blueprint | Reusable attribute values that other programming can reference. |
| Clip | A playback definition pointing to a sequence or effect, with its own options and controls. |
| Color path | The interpolation route used when fading into a destination color. |
| Console DMX | Nightfall's internal universe/channel address space before transport routing. |
| Cue | Stored fixture instructions within a sequence. |
| Cue part | A subset of cue programming with its own timing overrides. |
| Cycle length | How long one loop of an effect takes, such as 2 seconds, or 4 beats when the effect's timing is in beats. |
| DMX route | A connection in Patch that carries DMX: from fixtures or console channels to an output, or from an input to fixtures, console channels, another output, or `disabled` to ignore it. |
| Element | An independently addressable cell or part of a fixture. |
| Fader | One numbered strip in the Clips panel's fader bank, with a level and a button, that a clip or master can be assigned to. MIDI and OSC controls map to it by number. |
| Fixture | A patched light with a profile, operating mode, and optional DMX assignment. |
| Fixture profile | The definition translating fixture attributes to the channels and ranges of a mode. |
| Group | A reusable fixture selection, including its ordering. |
| HTP | Highest takes precedence: the highest applicable value wins a merge. |
| Instance | A running playback created from a sequence, effect, or clip. Multiple instances can contribute output. |
| Layer | One contribution to the composed fixture output. |
| LTP | Latest takes precedence: the most recently asserted applicable value wins a merge. |
| Master | A control that scales intensity or playback speed for a defined scope. |
| Programmer | The working selection and live instructions used to create looks. |
| Release | Removal of a playback's contribution, potentially with a transition. |
| Sequence | Ordered cues with timing, tracking, setup, and release behavior. |
| Showfile | The saved collection of a show's fixtures, programming, routing, and associated state. |
| Speed | A multiplier on how fast a playback runs: ×2 runs twice as fast, ×½ half as fast. Set per clip, or for many playbacks at once with a speed master. Unlike some consoles, a speed master has no BPM of its own; the show has one [tempo](tempo.md). |
| Timecode | A clock position used to coordinate time-based playback. |
| Tempo | The show's beats per minute, set by tapping or typing in the Tempo panel. |
| Timing | Whether an effect's or sequence's times are **Seconds**, which run on the clock, or **Beats**, which follow the show [tempo](tempo.md). |
| Timeline | Tracks of actions scheduled against a linked timecode. |
| Tracking | Carrying earlier attribute values into later cues that do not explicitly change them. |
| Universe | A bank of 512 DMX channels. |
