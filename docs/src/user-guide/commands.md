# Basic command syntax

{{#include ../includes/human-review-disclaimer.md}}

The top-toolbar command input and Console submit the same command language. Type a command, inspect validation and completion suggestions, then press Enter. An accepted command can still report an execution error if its referenced object does not exist.

## Fixtures and values

```text
fixture 1 @ 50
fixture 1 red @ 100 green @ 0 blue @ 0
fixture 1>4 @ 100
```

`@` sets a value; without an explicit attribute it sets intensity. These values are percentages. `1>4` selects fixtures 1 through 4. A fixture element uses a dotted address, such as `fixture 1.2`. Use only attributes available in the fixture's selected mode.

Selection order matters for fanned values and effects. Use Selection Inspector to inspect structured selections before simplifying or storing them.

## Store and play

```text
store cue 1.2
store cue 1.2 /merge
clip 1 start
clip 1 go
clip 1 stop
```

Create the sequence and configure the clip's source in their panels first. Cue `1.2` belongs to sequence `1`; clip `1` is a separate object with its own ID. See [Storing and recalling looks](stores.md) for overwrite modes.

## Clear, save, and recover

```text
clear
save
undo
redo
```

Clear removes programmer state; inspect Programmer to confirm values have been released. The Programmer toolbar additionally exposes a staged clear action that clears selection before values. Saving persists the current showfile. Undo and redo apply to recorded editing operations, not every live playback action.

Console keeps command history and reports errors. Use the UI's completion suggestions for less common commands rather than guessing object names or option syntax. The application menu's **Keyboard Shortcuts** reference shows the active shortcuts for your platform.
