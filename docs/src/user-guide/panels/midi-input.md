# MIDI Input

{{#include ../../includes/human-review-disclaimer.md}}

MIDI Input maps incoming controller events to Nightfall actions. Open it from the Command Palette. The connected-device section shows devices known to the engine.

Press a controller button and inspect **Last Input**, including device, channel, note, and velocity. Choose **Add Mapping** to create a row from that event, then edit its match fields and Action. The initial mapping targets `StartClip(1)`; change it to the intended action before testing the controller again.

Examples include `StartClip(1)` and `StopClip(2)`. Match values must reflect the event actually sent by the device. A button's press and release may produce different events, so observe both before choosing exact velocity matching.

Select mapping rows to delete obsolete assignments. Filters and hidden columns can obscure existing matches; clear them when investigating duplicate actions. If no input appears, check device detection before editing the mapping. Save the showfile to retain mappings.
