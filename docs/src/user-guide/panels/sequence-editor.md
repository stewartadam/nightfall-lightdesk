# Sequence Editor

{{#include ../../includes/human-review-disclaimer.md}}

Sequence Editor arranges and previews a sequence's cues. Open it from the **Sequences** list. Select rows to inspect cue settings in Properties or open the selected cue part editor.

The table exposes cue timing, triggers, and tracking. Sequence defaults apply where a cue has no override. An inherited value and an explicit zero have different meanings. Expand cue parts to give subsets independent timing, and inspect conflict indicators where parts overlap.

Use the toolbar to duplicate cues, move them up or down, or delete selected cues/parts. Review setup and release programming as well as numbered cues. Changing order can change tracked output even if the individual cue instructions stay the same.

## Preview

**Preview go**, **Preview back**, and **Jump preview to selected cue** let you inspect the sequence while editing. Preview options control transitions and tracking. Clear the programmer so it does not obscure the result, then stop preview when finished.

For operator playback, create a [Clip](clips.md) whose source is this sequence. See [Cues and timing](../cues.md) for the distinction between stored values, tracking, and release.
