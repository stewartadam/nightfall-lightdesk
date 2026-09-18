# Cue Editor

{{#include ../../includes/human-review-disclaimer.md}}

Cue Editor edits the fixture instructions stored in a cue or cue part. Open a cue from **Cues**, or select a cue/part in **Sequence Editor** and use its editor action. It is a contextual editor rather than a standalone palette entry.

Check the editor title for the selected cue, then edit attribute cells. Fixture-wide and element rows preserve the distinction between programming a complete fixture and programming a cell. Column visibility and filters help inspect wide fixtures; clear filters when auditing an entire cue.

Removing an attribute removes its stored instruction. Setting it to zero keeps an explicit instruction, which has different tracking behavior. Invalid values are rejected rather than silently becoming valid programming; correct the cell and confirm the result.

Properties provides contextual controls for the selected cue. For timing between cues and inherited defaults, use [Sequence Editor](sequence-editor.md). After editing, preview the sequence with Programmer cleared, then save the showfile.
