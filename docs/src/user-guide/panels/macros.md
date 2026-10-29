# Macros

{{#include ../../includes/human-review-disclaimer.md}}

A macro is a numbered list of commands that runs with one press. Macros lists the show's macros. Open it from the Command Palette, and use **Add macro** (N) to create one. The new macro opens in Properties, ready for its commands.

## Write a macro

Type one command per line in **Commands**, exactly as you would type it in the command line. You can also put several commands on one line separated by `;`. Use `sleep` to wait between commands:

```text
group 1 @ 0
sleep 2s
clip 4 stop
group 2 @ 100
```

Properties checks each line as you type and lists the lines it can't understand, with the line number. Your changes are saved when you leave the field or press Ctrl+Enter (Cmd+Enter). Escape puts back the saved text. The label and the commands are saved in the showfile, and edits can be undone.

**On release** holds commands that run when a held button that started the macro is let go, such as a MIDI pad or a board button. Leave it empty to ignore the release, so a quick tap runs every command.

## Run a macro

Click a card, press Enter on the selected macro, or Alt+click a row to run it. The card shows which line is running, and clicking it again stops the macro. **Run** in Properties saves any text you typed, then runs the macro. On the command line, `macro 3 start` and `macro 3 stop` do the same.

Commands run in order, each one after the previous one finishes. A macro stops at the first command that fails, and an error names the line, for example "Macro 3 stopped at line 2 (clip 99 start)". Starting a macro that is already running does nothing.

A macro can start another macro, and waits for it to finish. Stopping the first macro also stops the one it started. A macro that would start itself is refused.

Editing or deleting a running macro, or loading a show, stops it. Pressing Undo while a macro runs stops it and undoes what it did so far.

## Undo

A macro that runs without interruption is one undo step. If you change something while a macro is running, the commands the macro runs after your change form a new undo step above it, so undoing never brings back a value from before your change.

## Map a macro

Macros appear in the action picker under **Macros** wherever you can bind an action, such as MIDI and OSC mappings, keyboard shortcuts and timeline events. **Start macro** runs it, **Stop macro** stops it, and a held binding to **Start macro** runs the release commands when you let go.

You can also find a macro by typing its name in the object palette (Ctrl+P / Cmd+P).
