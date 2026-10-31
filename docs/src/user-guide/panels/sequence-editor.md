# Sequence Editor

{{#include ../../includes/human-review-disclaimer.md}}

Sequence Editor arranges and previews a sequence's cues. Open it from the **Sequences** list. Select rows to inspect cue settings in Properties or open the selected cue part editor.

The table exposes cue timing, triggers, and tracking. Sequence defaults apply where a cue has no override. An inherited value and an explicit zero have different meanings. Expand cue parts to give subsets independent timing, and inspect conflict indicators where parts overlap.

**Timing** in Properties sets whether the sequence runs on the clock or on the beat. With **Seconds**, trigger times, delays and fades are seconds. With **Beats**, they are beats of the [show tempo](../tempo.md): the table shows them with a `b` suffix, and you can type a number of beats or a fraction such as `3/4`. A chase whose cues follow each other after 1 beat then keeps time with every tap and tempo change, and a [speed master](masters.md) at 50% or 200% plays it at half or double time. A beat-timed sequence starts on the beat that is playing when you launch it. On a timeline, it follows the timeline's BPM, so seeking lands on the same cue and fade as playing through.

Use the toolbar to duplicate cues, move them up or down, or delete selected cues/parts. Review setup and release programming as well as numbered cues. Changing order can change tracked output even if the individual cue instructions stay the same.

## Preview

**Preview go**, **Preview back**, and **Jump preview to selected cue** let you inspect the sequence while editing. Preview options control transitions and tracking. Clear the programmer so it does not obscure the result, then stop preview when finished.

For operator playback, create a [Clip](clips.md) whose source is this sequence. See [Cues and timing](../cues.md) for the distinction between stored values, tracking, and release.
