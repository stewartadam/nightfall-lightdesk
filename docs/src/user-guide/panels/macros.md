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

**On release** holds commands that run whenever the macro ends: when its commands finish, when one fails, when you stop it, or when you let go of a held button that started it, such as a MIDI pad. Use it to put things back, for example to fade down what the macro brought up. Letting go of a held button stops the remaining commands and runs **On release** straight away. Leave it empty and letting go does nothing, so a quick tap runs every command.

## Run a macro

Click a card, press Enter on the selected macro, or Alt+click a row to run it. The card shows which line is running, and clicking it again stops the macro. **Run** and **Stop** in the toolbar run or stop every selected macro. **Run** in Properties saves any text you typed, then runs the macro. On the command line, `macro 3 start` and `macro 3 stop` do the same.

Stopping a macro runs its **On release** commands. Stopping it again while those run stops them too.

Commands run in order, each one after the previous one finishes. A macro stops at the first command that fails, and an error names the line, for example "Macro 3 stopped at line 2 (clip 99 start)". Starting a macro that is already running does nothing.

A macro can start another macro, and waits for it to finish. Stopping the first macro also stops the one it started. A macro that would start itself is refused.

Editing a running macro stops it and runs its **On release** commands. Deleting a running macro or loading a show stops it without them. Pressing Undo while a macro runs stops it, skips **On release**, and undoes what it did so far.

## Undo

A macro that runs without interruption is one undo step. If you change something while a macro is running, the commands the macro runs after your change form a new undo step above it, so undoing never brings back a value from before your change.

## Map a macro

Macros appear in the action picker under **Macros** wherever you can bind an action, such as MIDI and OSC mappings, keyboard shortcuts and timeline events. **Start macro** runs it, **Stop macro** stops it, and a held binding to **Start macro** runs the release commands when you let go.

Macros can also go on a board, as a single button or as a collection of macros. Pressing the button runs the macro, or stops it if it is running. Drag a macro card onto a board to add its button.

You can also find a macro by typing its name in the object palette (Ctrl+P / Cmd+P).
