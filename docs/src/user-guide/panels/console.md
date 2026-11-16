# Console

{{#include ../../includes/human-review-disclaimer.md}}

Console shows command input, history, and command results. Open it from the Command Palette or use Shift+backtick. The top-toolbar command input operates the same engine command language.

Type a command, use completion suggestions to inspect available syntax, and press Enter to submit. History search helps reuse earlier commands. An error message can distinguish invalid syntax from a valid command whose referenced object is missing.

Start with [Basic command syntax](../commands.md). Use the panel's history to review exactly what you submitted when a fixture or cue changes unexpectedly. Repeating a store or delete command can change show data again, so inspect recalled text before execution.

Console is useful evidence for a bug report: include the failing command, the response, the relevant object IDs, and the expected result. Use Instrumentation for runtime performance information.

## Session history

The **Session history** tab lists what happened since Nightfall started, newest first. It shows every command the engine accepted, from any source: this computer's interface, other devices, the command line, MIDI or OSC, and a primary's forwarded commands on a backup. Each entry has the time, the source, the command with its arguments, and whether it finished, failed with a reason, or still runs. Events also appear, such as a backup copying its primary's show, its link changing, or a takeover.

Filter the list by source, show only failed commands, or type text to match. **Copy as JSON** copies the entries shown, oldest first, for a bug report. Pairing PINs are hidden.

On a [backup server](io-transports.md#backup-server), a command the primary forwarded shows its number, such as `#42`, on both computers. Compare the two histories by that number to find where the backup stopped following.

Nightfall keeps the last 2,000 entries and reads them only while the tab is open. The history is separate from [Undo Stack](undo-stack.md), which lists only changes you can undo.
