# OSC Input

{{#include ../../includes/human-review-disclaimer.md}}

OSC Input maps incoming OSC messages to Nightfall actions. Open it from the Command Palette. The listener section shows whether the engine is listening and the actual bind address and port; use those details when configuring the sender.

Send a message and inspect Known Sources and **Last Input**. Choose **Add Mapping**, then edit Source, Address, Arg Index, Arg Match, and Action. The new row initially uses `StartClip(1)`; replace it with your intended action before sending another test message.

Leave Source blank to match any sender. Argument index and match values narrow which messages trigger an action. Supported action forms displayed by the panel include `StartClip(1)`, `StopClip(2)`, `GoClip(3)`, `SetControl(1)`, and `Eval(clip 1 go)`.

If a mapping does not run, first verify the message appears in Last Input, then check address and argument matching. Review all mappings for overlap if one message triggers multiple actions. Select rows to delete them and save the showfile to keep configuration.
