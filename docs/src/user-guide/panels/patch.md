# Patch

{{#include ../../includes/human-review-disclaimer.md}}

Patch defines the fixtures in your show and their DMX routing. Open **Patch** from the Command Palette.

## Add or change fixtures

Use the add-fixture wizard to select a library definition and mode, set quantity, first fixture ID, and label, choose a console universe and start address, and review the result before Finish. **Assign Console DMX** can be disabled when you only need a virtual fixture. A mode's channel footprint must match the physical light's mode. For how universes, addresses, and fixture IDs relate, see [Patching fixtures with DMX](../dmx-patching.md).

The **Fixtures** tab lists IDs, labels, make/model, mode, channel width, and 3D placement. Edit labels and placement cells here. Fixture IDs identify lights in commands; DMX addresses are separate. Multi-element fixtures can expose several controllable cells under one fixture ID.

## Output offsets

An output offset shifts what one fixture sends for an attribute, after cues, FX, the programmer and masters. Use it to line up a mover that is mounted slightly off, or to match a fixture's color to its neighbors without reprogramming cues.

Select one fixture in the **Fixtures** tab, then open **Properties**. **Output offsets** lists each of the fixture's DMX attributes with its offset, in percent of the parameter's range, from -100% to 100%. Type a value or use the steppers; the offset applies as soon as you stop typing or press Enter. Attributes with an offset are highlighted, and the reset button sets one back to 0%. An offset applies to every element of the fixture that has the attribute, is saved with the show, and undoes like any other edit.

From the command line, `store fixture 5 offset pan 2%` sets the same offset. Without `%`, the value is in the parameter's DMX units, for example `store fixture 5 offset pan 3`.

## Route DMX

The **DMX Routes** tab lists every DMX route. Group by fixture or universe to inspect them, and check Source, Target, Priority, and Clone values. Resolve highlighted conflicts before outputting to hardware; overlapping addresses can make one command affect the wrong light.

A console address alone does not select a network destination or USB device. Configure output targets in [I/O Transports](io-transports.md), then add DMX routes from console channels to those targets. Use [Console DMX](console-dmx.md) to inspect console universe values, or the wire frames each transport sends.

Output is sent only where a DMX route sends it: a fixture or console range with no output route sends nothing. To stop output, remove the route, for example `rm patch fix 12 @ artnet:1`. Only inputs can be patched to `disabled`, which ignores incoming DMX that matches the source.

Some GDTF modes split their channels across several DMX breaks, such as a lamp with an accessory scroller that has its own start address. A fixture's route covers break 1. Give each additional break its own route to an output target, for example `patch fix 12 break 2 @ artnet:2.1`. The Fixture Library's **Mode Parameters** list shows which break each channel belongs to.

Changing fixture mode changes how channels represent attributes. Review the wizard's version/mode warnings and confirm your routing after a change. Save the showfile when the patch is correct.
