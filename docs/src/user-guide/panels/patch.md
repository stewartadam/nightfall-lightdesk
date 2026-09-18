# Patch

{{#include ../../includes/human-review-disclaimer.md}}

Patch defines the fixtures in your show and their DMX routing. Open **Patch** from the Command Palette.

## Add or change fixtures

Use the add-fixture wizard to select a library definition and mode, set quantity and label, choose a console universe and start address, and review the result before Finish. **Assign Console DMX** can be disabled when you only need a virtual fixture. A mode's channel footprint must match the physical light's mode.

The **Fixtures** tab lists IDs, labels, make/model, mode, channel width, and 3D placement. Edit labels and placement cells here. Fixture IDs identify lights in commands; DMX addresses are separate. Multi-element fixtures can expose several controllable cells under one fixture ID.

## Route DMX

The **DMX I/O** tab shows bindings. Group by fixture or universe to inspect routes, and check Source, Target, Priority, and Clone values. Resolve highlighted conflicts before outputting to hardware; overlapping addresses can make one command affect the wrong light.

A console address alone does not select a network destination or USB device. Configure output targets in [I/O Transports](io-transports.md), then use bindings to route console channels to those targets. Use [Console DMX](console-dmx.md) to inspect channel values independently of the physical transport.

Changing fixture mode changes how channels represent attributes. Review the wizard's version/mode warnings and confirm your routing after a change. Save the showfile when the patch is correct.
