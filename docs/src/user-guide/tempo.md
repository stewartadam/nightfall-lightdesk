# Show tempo and tap tempo

{{#include ../includes/human-review-disclaimer.md}}

Nightfall keeps one tempo for the whole show. The status bar shows it as a BPM readout with a row of beat dots, where the larger dot is beat 1 of the bar. On a phone the readout sits in the header. Everything that follows the tempo, such as the [Show Tempo flow node](#flows), reads this same clock.

## Tapping a tempo

Press **Tap** on the beat. The button responds the moment you press it, so tap on the attack of the beat rather than on release.

- **The first tap marks beat 1.** If you haven't tapped for more than 3.5 seconds, your next tap is treated as a downbeat. It moves the bar so that tap becomes beat 1 and leaves the tempo unchanged.
- **Each tap after that refines the tempo.** From the second tap on, Nightfall fits a steady beat through your recent taps. The BPM comes from their spacing, and the beat is pulled into line with where you tapped.
- **Only your last 8 taps count.** Tapping longer does not keep averaging. Once you have tapped about 8 times, the tempo follows the most recent 8 taps (roughly two bars). That lets you keep tapping to follow a song that speeds up or slows down, and older taps stop influencing the result.
- **A stray tap starts a fresh count.** A tap that lands more than 40% early or late compared with the current beat spacing is not averaged in. A double tap or a skipped beat are typical examples. Nightfall keeps the current tempo and starts counting again from that tap, so the next few taps set the tempo.
- **Stopping is safe.** When you stop tapping, the tempo keeps running at the last value.

For the steadiest result, tap 8 or more beats evenly. To mark where the bar starts, pause for a few seconds and then tap on the "1".

## Changes never jump

Tempo changes glide rather than jump, so chases and effects running on the beat keep playing smoothly instead of skipping or restarting.

- **New tempos** glide in over about one beat. Going from 120 to 128 BPM takes about half a second.
- **Beat alignment changes** from taps, **Resync** or **Nudge** are spread over about one bar. The beat runs slightly fast or slow until it lines up, never more than 25% off speed. Larger corrections take longer: in 4/4, shifting the beat by two whole beats takes about two bars.

**Jump to next downbeat** is the one exception. It moves straight to the start of the next bar.

## Tempo menu

Click the BPM readout to open the tempo menu.

| Control | What it does |
| --- | --- |
| **Tempo (BPM)** | Type a tempo between 20 and 300 BPM, or use the − and + buttons. Typed values apply when you press Enter, leave the field, or pause typing. |
| **Beats per bar** | Sets the bar length from 1 to 16 beats. The bar you are in keeps its downbeat and the bar count carries on, so changing the length mid-song does not shift where bars start. |
| **Half time** / **Double time** | Halves or doubles the tempo. |
| **Resync to downbeat** | Makes this moment beat 1 of a bar without changing the tempo. Use it when the tempo is right but the "1" has drifted. |
| **Jump to next downbeat** | Skips straight to the start of the next bar. |

## Commands

The [command line](commands.md) controls the same tempo.

```text
tempo 128
tempo tap
tempo half
tempo double
tempo resync
tempo snap
tempo nudge -0.25
tempo bar 3
```

`tempo snap` jumps to the next downbeat. `tempo nudge` shifts the beat by a number of beats: a positive value moves the beat earlier, a negative value moves it later. `tempo bar` sets the beats per bar.

Because `tempo`, `tap`, `half`, `double`, `resync`, `snap`, `nudge` and `bar` are command words, they can't be used as custom attribute names.

## MIDI and OSC

In the [MIDI Input](panels/midi-input.md) and [OSC Input](panels/osc-input.md) mapping tables, these actions control the tempo:

| Action | Effect |
| --- | --- |
| `TapTempo` | One tap, with the same rules as the Tap button. |
| `ResyncTempo` | Resync to downbeat. |
| `SetTempo(128)` | Sets the tempo in BPM. |
| `MultiplyTempo(0.5)` | Multiplies the tempo, for example `0.5` for half time and `2` for double time. |
| `NudgeTempo(-0.25)` | Shifts the beat by the given number of beats. |

Tempo actions run when a button is pressed and ignore the release. Taps from a MIDI or OSC controller are timed when Nightfall processes them, which can add a few milliseconds of jitter compared with the on-screen button.

## Flows

The **Show Tempo** node outputs the current **BPM**, the **Beat** within the bar and the **Bar** count (both starting at 1), and the **Phase** through the current beat from 0 to 1. Its **On Beat** and **On Bar** triggers fire once for every beat and every downbeat.

## Limitations

The tempo is not yet saved in the showfile. Each session starts at 120 BPM in 4/4.
