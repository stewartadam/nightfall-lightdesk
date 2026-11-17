# MIDI Input

{{#include ../../includes/human-review-disclaimer.md}}

MIDI Input lists the show's MIDI devices and every MIDI binding in the show. Open it from the Command Palette. For the quickest way to bind controls, use mapping mode, described in [Controllers and keybindings](../controller-mapping.md).

When you plug in a controller while Nightfall is running and the show has no bindings for it yet, a notification names it and offers **Open MIDI Input**, which opens this panel. Tick **Don't show this again** to stop these notifications on the computer or tablet you are using. To bring them back, choose **Show again** next to **Hidden prompts** in Settings, under General.

**MIDI Devices** shows the controllers Nightfall can hear and the ones the show has bindings for. Press a button or move a fader and **Last Input** shows the device, the control, and its channel. To bind that control from here, pick an action and a behavior beside Last Input and choose **Add Mapping**.

## Several controllers of the same model

You can use two or more identical controllers, such as two APC minis, at once. Nightfall numbers them, so they show as "APC mini" and "APC mini (2)", and each one keeps its own bindings and LED feedback.

Nightfall recognizes each controller by its USB serial number, on Windows, macOS and Linux alike, so a show moved to another computer finds its controllers again. A controller you have not bound yet is marked **New**. Its number is saved with the show once you bind one of its controls or change its LED feedback. A controller the show knows that is unplugged is marked **Not connected**.

Some controllers have no serial number, or share one with their twins. Nightfall tells those apart by the USB port they are plugged into. When only one controller of a model is plugged in and the show knows only one of that model, it is recognized anyway. Otherwise it shows as **New** on another port or another computer: choose **Assign to…** next to it and pick the controller it replaces, and its bindings follow it from then on. If you swap two of them between ports, swap their cables back, or assign them again.

Each row in the table is one binding:

- **Device** is the controller the binding listens to. A device that is not connected is marked "(not connected)". Pick another device to move the binding to it, for example to give a second identical controller the same layout.
- **Control**, **Channel**, and **Number** identify the button, fader, or knob. Channel and Number can be edited.
- **Behavior** decides what pressing and releasing the control does. See [Behaviors](../controller-mapping.md#behaviors).
- **Action** is what the control runs. Select one row to change its action with the picker above the table.
- **Status** flags bindings that cannot run, such as one whose clip was deleted.

Edits apply to every selected row. Select rows and choose **Delete** to remove them. Filters and hidden columns can hide existing bindings, so clear them when a control seems to trigger something unexpected.

If nothing appears in Last Input, check that the controller is connected and shows up under MIDI Devices. Save the showfile to keep your bindings.
