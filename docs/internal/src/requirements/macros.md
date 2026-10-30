# Macros

{{#include ../includes/human-review-disclaimer.md}}

A macro is a numbered show object, such as Macro 3, that holds a few lines of command-line text. Starting the macro runs those lines in order on the engine, exactly as if the operator typed them, and stops at the first line that fails. Every surface that can fire an action can start a macro: a board button, a MIDI or OSC pad, a keybinding, a timeline event, or `macro 3 start` on the command line.

This page records what macros must do and why. Read it before you change how macros run, how they interact with undo, or which surfaces can start them.

## Problem

Operators repeat the same short sequences of commands during a show, such as "fade the washes out, wait two seconds, stop the chase clip, then bring up the specials." Before macros, two partial tools covered this:

- The `desk.eval` action runs one command line from any action surface, but only one statement. A MIDI pad or timeline event can't run a sequence.
- The web UI console runs `a; b` sequences, but the sequence runner lives in the browser. Nothing else can use it, and it stops when the browser tab closes.

Macros give the operator one named, numbered object that runs a sequence the same way from every surface, with the engine as the single authority on what ran and what failed.

## Users and goals

The following table lists who uses macros and what each needs:

| User | Goal |
|------|------|
| Busking operator | Fire a multi-step look change from one button, and stop it partway if the moment passes. |
| Show programmer | Write a sequence once, give it a number and a label, and reuse it from boards, MIDI pads, and timelines. |
| Timeline author | Trigger the same sequence at a cue point without copying its commands into the timeline. |

## Requirements

### Definition

- A macro is a show object with an ID, a label, and a persistent UID, numbered like clips and cues.
- A macro has a press body and an optional release body. Each body is command-line text, one statement per line. A line can hold several statements separated by `;`.
- The showfile stores each body as the text the operator typed, so blank lines and layout survive a save.
- Macros are saved in the showfile, and showfile import offers a merge policy for them like other objects.
- Creating, editing, renumbering, and deleting a macro are undoable.
- Bodies are typed. Nightfall doesn't record a macro by watching what the operator does.

### Running

- The engine runs a macro, not the web UI, so every surface behaves the same and a run continues when no browser is connected.
- Statements run one at a time, in order. A statement starts only after the previous one finishes, so `sleep 2s` pauses the run.
- The run stops at the first statement that fails. The error names the macro, the line number, the line's text, and the statement's own error, for example "Macro 3 stopped at line 2 (clip 99 start): " followed by the reason clip 99 couldn't start.
- The command that started the macro finishes when the run finishes, and fails when the run fails. A parent that waits on it, such as the console or another macro, sees the real outcome.
- Starting a macro that is already running does nothing and tells the operator it is already running.
- `macro <id> stop` and the `macro.stop` action end the run. Statements that haven't started never run, and the run doesn't wait for a `sleep` in progress.
- Stopping a macro also stops any macro it started, along with that macro's remaining statements.
- Deleting a running macro, editing the body it runs, or loading a show stops it. Editing it moves on to the release body; deleting it or loading a show does not.
- A macro can start another macro. The parent waits for the child to finish. A macro that would start itself, directly or through other macros, fails with an error. Nesting deeper than eight macros fails with an error.
- The engine reports every running body with its current line and statement count, so the web UI can show progress.

### Press and release

- `macro.start` is a momentary action. A held binding, such as a MIDI pad, runs the press body on press and sends `macro.release` on release.
- The release body runs whenever the press body ends: it finishes, a statement fails, the macro is stopped, its running body is edited, or a held binding is released. The command that started the macro finishes after the release body, and reports the press body's failure if there was one.
- On release of a held binding, the engine stops whatever remains of the press body, then runs the release body. Releasing after the press body already ended does nothing, because the release body already ran.
- A macro without a release body ignores the release, so a quick tap runs the whole press body.
- Stopping a macro while its release body runs stops the release body.
- Undo, redo, deleting the macro, and loading a show end a run without its release body, since running more commands would act on a show the operator just replaced.

### Undo

- A run that nobody interrupts is one undo step.
- When the operator makes an undoable change while a macro runs, the macro's later statements start a new undo step above the operator's change. History stays in the order things happened, and undoing never restores a value from before the operator's change on top of it.
- Pressing **Undo** or **Redo** while a macro runs stops the run first, so the macro doesn't keep applying statements on top of the undone state. An `undo` or `redo` line in a macro's own body steps the history and the macro keeps running.
- Starting, releasing, and stopping a macro add nothing to the undo history themselves. Only the statements a run executes do.

The following example shows the undo rule. Macro 3 runs `group 1 intensity 50`, `sleep 2s`, `group 1 color red`, `sleep 2s`, `group 1 intensity 100`. Group 1 starts at intensity 0 and white:

| Time | What happens | Undo history, newest last |
|------|--------------|---------------------------|
| 0 s | Macro line 1 sets intensity 50. | Macro step A |
| 1 s | The operator sets intensity 20. | Macro step A, operator step |
| 2 s | Macro line 3 sets color red. The newest step isn't the macro's, so the macro starts step B. | Macro step A, operator step, macro step B |
| 4 s | Macro line 5 sets intensity 100. The newest step is macro step B, so the change joins it. | Macro step A, operator step, macro step B |

The first undo returns group 1 to white at intensity 20, the operator's value. The second returns it to 50, and the third to 0. Every undo lands on a state that really existed.

## Out of scope

The following items are deliberately left out of the first version:

- Parameters passed into a macro when it starts.
- Starting a macro on the next beat or bar.
- Macros on fader slots.
- Script languages other than the command line.
- Recording a macro from the operator's actions.

## Delivery stages

Each stage ships as its own pull request:

1. Engine: the macro object, showfile support, the runner, undo behavior, the actions, and the `macro <id> start` and `macro <id> stop` commands.
1. Web UI and boards: a **Macros** panel, an editor in **Properties** for both bodies with line errors, run progress, failure messages, and macros as board buttons and collections that light while running and can be dragged onto a board from the **Macros** panel.
1. Console: the console sends multi-statement lines to the engine's runner, and the browser's sequence runner is removed.
1. Parameters.

## In the code

| Concept | Where to look |
|---------|---------------|
| Macro definition | `crates/common/src/macros.rs` |
| Plugin, systems, and messages to clients | `crates/macros/src/lib.rs`, `crates/macros/src/websocket.rs` |
| Runner, nesting, and progress reports | `crates/macros/src/runner.rs` |
| Macro commands and undo or redo stopping runs | `crates/macros/src/command.rs` |
| Undo inverses | `crates/macros/src/undo.rs` |
| `macro.start`, `macro.release`, and `macro.stop` | `crates/macros/src/actions.rs` |
| `macro <id> start` and `macro <id> stop` grammar | `crates/cmd-parse/src/slots/contracts.rs`, `crates/cmd-parse/src/parser/strict/transport.rs`, `crates/macros/src/ast_conv.rs` |
| Showfile contributor | `crates/showfile/src/contributors/macros.rs` |
| End-to-end tests | `crates/app-runtime/src/tests/macros.rs` |

## Related topics

- [From command to state change](../engine/command-path.md)
- [Crate map](../architecture/crate-map.md)
- [The frame loop](../engine/frame-loop.md)
