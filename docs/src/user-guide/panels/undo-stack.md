# Undo Stack

{{#include ../../includes/human-review-disclaimer.md}}

Undo Stack displays recorded editing history and the operations available to undo or redo. Open it from the Command Palette before undoing a series of unfamiliar changes.

Inspect the descriptions and ordering to identify the operation you want to reverse. Use the application's Undo and Redo actions, then confirm the affected object in its own panel. New edits after an undo can replace the redo path.

Not every action is a reversible edit: starting playback, receiving external input, and saving a file serve different purposes. Stop playback with its transport controls rather than assuming Undo will stop it.

Undo history is useful during a session, but a saved showfile and its revisions provide recovery across sessions. Save before broad edits and use Open Showfile to inspect available backups.
