# Writing release notes

Part of the [contributing guide](../../CONTRIBUTING.md). For the `Notes:` syntax and
how notes reach a release, see [PR release notes](release-notes.md).

Release notes tell someone who runs shows with Nightfall what is different after
they update. They are not a summary of the PR. Each entry should be readable in a
few seconds by someone who never saw the code or the discussion.

## Rules

1. **Only what a user notices.** Write about behavior a user can see, hear or rely
   on in the app, the output or a saved show. If nothing changes for them, use
   `Notes: none (reason)`.
2. **The result, not the work.** Say what is now true ("Art-Net output now…",
   "Deleting a fixture no longer…"), not what the PR did ("Refactored…",
   "Replays changes as they happen instead of twice a second…").
3. **One change per entry, one short sentence each.** At most 160 characters per
   entry. Use an empty `Notes:` line and bullets for more than one entry.
4. **Only the headline changes.** At most five entries. Pick what a user would want
   to hear about and leave out smaller polish, internal steps and side effects.
5. **No how-to.** Do not walk through steps, buttons, dialogs or command syntax.
   Name the feature and where to find it, in a few words at most; the user guide
   explains how to use it.
6. **No implementation detail.** Leave out timings, thresholds, crate, module and
   message names, protocols between Nightfall's own processes, and how a fix works.
   A number belongs only when it is the user-visible point (for example a new
   output rate).
7. **Plain words.** Use the names users see in the app. Write in the present
   tense, without "we", and without hedging or praise.

### Internal-only changes get no notes

Use `Notes: none (reason)` for changes a user cannot observe, even when they are
large or important to the project:

- tests, CI, build, tooling and developer docs;
- refactors and performance work with no felt difference;
- changes to how Nightfall's own components talk to each other, such as sync
  timing between servers or replay mechanics;
- intermediate states, loading banners and progress indicators that only appear
  around the real change;
- partial work that users can't reach yet.

Keep the reason specific: `Notes: none (test-only change)`, not `Notes: none (n/a)`.

## Examples

### Good

```markdown
Notes:
- A backup server now takes over on its own when its primary stops answering.
- A backup and its primary stay paired across restarts and takeovers, until either one selects Leave the pair.
```

```markdown
Notes:
- USB DMX output now supports FTDI-based Open DMX dongles.
- Several clones sharing a serial number keep driving their own targets as long as each stays on its USB port.
```

```markdown
Notes: Notifications now show on top of Settings, About and other dialogs instead of hiding behind them.
```

```markdown
Notes: A command typed while the app is reconnecting now fails with an error instead of freezing the command line.
```

```markdown
Notes: none (backup servers already stayed in sync; this only changes how often they exchange updates)
```

### Bad

Too long, a tour of every step, and mostly actions rather than changes:

```markdown
Notes: A backup server now takes over on its own when its primary stops answering for 3 seconds, unless the primary's sACN still arrives. You can turn this off under Failover (formerly Backup server). Failover now lists both computers with their role, whether the backup is synchronized and the latency between them, with red tags only for errors. A primary that comes back after its backup took over steps down and follows the backup… You now start following a primary from the Showfiles dialog, which checks the address and pairing PIN first. You can leave backup mode with Leave the pair or by opening a show.
```

Internal behavior that users do not notice, written as user-facing notes:

```markdown
Notes: A backup server now replays clip, fader, master, tempo, timecode and programmer changes from the primary as they happen, instead of catching up twice a second. The backup's banner shows when it is still loading the primary's show.
```

A how-to with command syntax instead of the change:

```markdown
Notes: Park holds fixture parameters over cues, FX, the programmer and masters until you unpark them. Use `park fixture 5` to hold the current value, `park fixture 5 intensity @ 80` to hold a set value, `unpark fixture 5`, or the Parked section in Properties.
```

Better: `Notes: Park holds fixture parameters at a fixed value over all playback until you unpark them.`

## How this is checked

The required **Release notes** check fails an entry longer than 160 characters or
a declaration with more than five entries. The Claude mergeability review reads
this guide and sends PRs whose notes break the other rules to a human, with the
reason in its comment.
