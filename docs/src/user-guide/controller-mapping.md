# Controllers and keybindings

{{#include ../includes/human-review-disclaimer.md}}

Nightfall can run its actions from MIDI controllers, OSC senders, and your keyboard. Starting a clip, setting a master's level, toggling timeline playback, or opening a panel are all actions. Anything you bind runs exactly as if you had clicked it.

MIDI and OSC bindings are saved in the showfile, so save the show to keep them. Keybindings belong to the browser you made them in.

## Mapping a control

The quickest way to bind a controller is mapping mode:

1. Turn on mapping mode with the plug button in the header, or run **Toggle Controller Mapping Mode** from the Command Palette. On a phone, the palette is the only way to turn it on. A banner across the top confirms you are mapping.
2. Press a button, move a fader, or send an OSC message. The banner names the control it heard.
3. Click one of the highlighted controls on screen, such as a clip's Go button, a master's fader, or the timeline's play button. Controls the touched control cannot drive are dimmed.
4. Choose how the binding behaves from the menu that appears. Nightfall suggests the most likely choice: a fader follows a level, and a button acts on press.

Repeat steps 2 to 4 for each control, then press **Done** in the banner or press Escape.

To bind an action that has no button on screen, touch the control and then choose the action from the Command Palette. To see what is already bound to an on-screen control, click it without touching a controller first.

While anyone is mapping, Nightfall pauses all MIDI and OSC actions. A control touched while mapping is never fired by accident. Other people connected to the show see a banner saying actions are paused. Loading a show ends mapping mode for everyone.

Binding a control that already has a binding replaces it. Nightfall says which binding it replaced, and **Undo** restores it.

## Behaviors

Each binding has a behavior that decides what pressing and releasing the control does:

- **On press** runs the action when the button goes down. On a fader, **Follow fader** sets the level as the fader moves.
- **On release** runs the action when the button comes back up.
- **While held** runs the action on press and its opposite on release. For example, a toggle master stays on only while you hold the button, and a clip plays only while you hold it.
- **Flash to full** pushes a level to full while the button is held and restores the previous level on release.

An action only offers the behaviors that make sense for it. You can change a binding's behavior later from the MIDI Input or OSC Input panel.

## Keybindings

Open **Settings** and choose **Keyboard** to add your own keybindings:

1. Choose **Add keybinding**, then **Record keys**, and press the key combination.
2. Pick the action to run.

If the combination is already in use, Nightfall lists what it would replace and asks you to confirm. You can also turn off built-in shortcuts you never use, so they stop catching keys meant for something else. The application menu's **Keyboard Shortcuts** reference lists every active shortcut.

Some actions belong to a panel, such as inserting a timeline action. Their keybindings only work while that panel is open. Pressing one while the panel is closed shows a message saying the action is not available right now.

## When a binding does nothing

The **Status** column in MIDI Input and OSC Input flags bindings that cannot run, for example because the clip or master they control was deleted. A message also appears when a bound action fails, naming the action, the reason, and which control sent it.

If a MIDI controller was renamed or replaced, its bindings show its old name marked "(not connected)". Pick the new device in the **Device** column to move them across. Select several rows first to move them all at once.
