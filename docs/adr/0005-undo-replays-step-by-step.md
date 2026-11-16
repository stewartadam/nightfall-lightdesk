# 5. Undo and redo replay a group step by step, within one update

- Status: Accepted
- Date: 2026-11-15

## Context

One undo step can hold several entries. A macro run, an `Eval` with several statements, or a board press that lowers to several commands all record one undo group, with one inverse per change, in the order the changes ran.

Each domain owns its undo logic. A command type implements `Undoable`, which computes an inverse from the current state through a read-only `UndoContext`, and only the domain's handler, running in `EventHandling`, can apply a command. The undo crate depends on no domain.

Replaying a group therefore has two constraints:

- **Each inverse depends on the state the previous entries left.** Take a macro that runs `store group 905`, then `mv group 905 906`. Undoing it renames 906 back to 905, then deletes 905. Redoing it must capture "rename 905 to 906" only after 905 exists again. An inverse computed against the state before the replay started is wrong for every entry after the first.
- **Only a handler can apply an entry.** The undo system queues an entry's replay, and the domain handler applies it on its next run. The next inverse can only be captured once that has happened.

The first implementation computed every inverse up front, against one snapshot, and replayed the group in one go. A group that created and then deleted or renamed the same object could not be undone, and the failed group blocked every older undo step. Redo also replayed multi-entry groups in reverse.

## Decision

### Replay one entry per step

Undo and redo replay a group one entry at a time, in `handle_undo_commands`:

1. Capture the inverse of the next entry against the current state.
1. Queue the entry's replay as its own step command, with a fresh command ID, a detached reply target, and the undo-replay mark, so its handler restores the saved state instead of validating it as a new edit.
1. Wait for that step command's `FinishedCommand`, then go back to step 1.

When every entry has replayed, the captured inverses form a group on the opposite stack and the undo or redo command succeeds.

Around that loop:

- **Commands queue.** An undo or redo that arrives while a replay is in flight waits, so it always sees the history the previous one left.
- **Edits made during a replay are deferred.** The undo manager holds groups committed while a replay is in flight and commits them after it, so history stays in GURQ order.
- **A failed step splits the group.** The entries that replayed move to the opposite stack as one group, the failed entry and the rest go back where they came from, and the command fails with `undo.state_conflict` or `redo.state_conflict`. The undo is partial, but both halves stay reachable.
- **Clear history runs at once.** It bumps the history generation. A replay or queued command from an older generation fails with `history_cleared`, so clearing always works, even when a step never finishes, and a show load never replays the old show's history.

### Apply commands in their own schedule, and rerun only that

Each step needs the handlers to run once more after it is queued. At one run per update, a group of N entries would take N frames, about 23 ms each at 44 fps, and a render pass could show a half-replayed group.

Applying commands is therefore its own Bevy schedule, `ApplyCommands`, instead of a stretch of `Update`:

- `ApplyCommands` holds `PendingCommandExpansion`, `PendingCommandProcessing` and `EventHandling`, plus the systems that must run between two steps because they finish commands or keep state that handlers and inverses read. Today those are programmer workflow completion, the reference index that delete guards read, the manual and transport DMX layers that apply DMX release and restore operations, and fader reassignment.
- `Update` runs it once per update from the `CommandApplication` set, after input handling. Systems that publish, persist or derive output from what commands changed, such as showfile saves, settings sync, object change publication, resync and the macro runner, stay in `Update` after `CommandApplication`, as do pollers and timers such as device scans and stale DMX input expiry.
- While a step is in flight, `handle_undo_commands` calls `CommandRerun::request`, and `CommandApplication` runs `ApplyCommands` again straight away. It stops asking after two runs in a row in which its step neither finished nor changed, so a slow step carries on in later updates.
- Reruns stop after 8 ms or 256 runs in one update, and a rerun starts only when the longest run so far still fits that budget, so a rendering frame is not pushed past its output tick. Work left over carries on in the next update, which the frame limiter starts early.

Schedule membership is the only list of what reruns: a system reruns because it is registered in `ApplyCommands`. Input handling, delayed commands coming due, timers, publication and the render pass are in other schedules and run once per update whatever the reruns do.

Ordering only applies between systems of one schedule, so an `Update` system ordered against `EventHandling` would silently lose that ordering. A test in `app-runtime` builds the full app and fails when either schedule orders against, or configures, a set whose systems all live in the other one.

A typical undo of a macro with four entries now settles in one update: the first run starts the first step and each rerun finishes one step and starts the next.

### Alternatives considered

- **Compute every inverse up front.** This was the original design. It is wrong for any group whose entries touch the same object.
- **Apply inverses directly, without the domain handler.** Each domain would need a second apply path for undo, and the undo crate would depend on every domain. Handlers would also stop being the one place that validates and publishes a change.
- **Rerun the whole of `Update`, with input sets opted out by a run condition.** This was the first version of this change. Every `Update` system outside the opted-out sets would rerun, and no check could show that all of them tolerate it.
- **Rerun only an allowed list of sets.** Bevy can't run a set on its own, so this means run conditions on everything outside the list, kept in step by hand: a second membership list beside the schedule.
- **Register each type's handler with the undo registry and run it directly.** This needs one more registration per undoable type, and systems ordered after `EventHandling` would not run between steps.
- **Keep one run per update.** Simplest, but undo latency grows with group size and render passes see partial groups.

## Consequences

- Undo and redo of any group work, including groups that create, rename and delete the same object, and redo replays entries in the order they first ran.
- Most undos and redos finish in the update they are submitted in, so clients and output never see a half-replayed group. A very large group, or one with a step that waits on several updates of work, still spreads across updates, and the queue and deferral rules keep that safe.
- A conflict partway through a group leaves a partial undo. The error says so, and the replayed half can be redone.
- Command handlers register in `ApplyCommands`, not `Update`. `Update` systems order against `CommandApplication`, not against the sets inside `ApplyCommands`.
- A new system that finishes commands, or keeps state that handlers or inverses read, belongs in `ApplyCommands` after `EventHandling`. Everything else that reacts to command changes belongs in `Update` after `CommandApplication`.
- Every system in `ApplyCommands` can run several times in one update, so it must be safe to rerun: a run with no new input changes nothing and publishes nothing. Handlers meet this by acting on each message they read once. The `rerun_safety` test in `app-runtime` runs a sample show with an extra run in every update and fails when command results, client messages or output differ.
- Other work that settles in dependent steps can use `CommandRerun::request`.
