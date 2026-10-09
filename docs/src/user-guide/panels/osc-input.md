# OSC Input

{{#include ../../includes/human-review-disclaimer.md}}

OSC Input shows the OSC listener and every OSC binding in the show. Open it from the Command Palette. For the quickest way to bind controls, use mapping mode, described in [Controllers and keybindings](../controller-mapping.md).

The listener section shows whether Nightfall is listening and on which address and port. Point your OSC sender there. Send a message and it appears under **Known Sources** and **Last Input**. To bind the control that sent it from here, pick an action and a behavior beside Last Input and choose **Add Mapping**.

Each row in the table is one binding:

- **Source** limits the binding to one sender. Leave it blank to accept messages from any sender.
- **Address** is the OSC address the binding listens to.
- **Arg Index** picks which argument to read, and **Arg Match** runs the binding only when that argument has a given value. **Release Match** is the value the control sends when a button is let go.
- **Min** and **Max** describe the range a fader sends, for example 0 to 127. Leave them blank for the usual 0 to 1. Setting Min above Max reverses the fader.
- **Behavior** decides what pressing and releasing the control does. See [Behaviors](../controller-mapping.md#behaviors).
- **Action** is what the message runs. Select one row to change its action with the picker above the table.
- **Status** flags bindings that cannot run, such as one whose clip was deleted.

Edits apply to every selected row. Select rows and choose **Delete** to remove them.

If a binding does not run, first check that the message appears in Last Input, then check its address and argument matching. Save the showfile to keep your bindings.
