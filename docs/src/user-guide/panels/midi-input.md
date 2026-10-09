# MIDI Input

{{#include ../../includes/human-review-disclaimer.md}}

MIDI Input lists connected MIDI devices and every MIDI binding in the show. Open it from the Command Palette. For the quickest way to bind controls, use mapping mode, described in [Controllers and keybindings](../controller-mapping.md).

**Connected MIDI Devices** shows the controllers Nightfall can hear. Press a button or move a fader and **Last Input** shows the device, the control, and its channel. To bind that control from here, pick an action and a behavior beside Last Input and choose **Add Mapping**.

Each row in the table is one binding:

- **Device** is the controller the binding listens to. A device that is not connected is marked "(not connected)". Pick a connected device to move the binding to it, for example after replacing a controller.
- **Control**, **Channel**, and **Number** identify the button, fader, or knob. Channel and Number can be edited.
- **Behavior** decides what pressing and releasing the control does. See [Behaviors](../controller-mapping.md#behaviors).
- **Action** is what the control runs. Select one row to change its action with the picker above the table.
- **Status** flags bindings that cannot run, such as one whose clip was deleted.

Edits apply to every selected row. Select rows and choose **Delete** to remove them. Filters and hidden columns can hide existing bindings, so clear them when a control seems to trigger something unexpected.

If nothing appears in Last Input, check that the controller is connected and shows up under Connected MIDI Devices. Save the showfile to keep your bindings.
