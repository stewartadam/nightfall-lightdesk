# Console DMX

{{#include ../../includes/human-review-disclaimer.md}}

Console DMX displays DMX channel values, either as Nightfall's console universes or as the frames each output transport sends. Open it from the Command Palette, pick a view in the **Transport** select, then choose the universe you want to inspect.

## Console and wire numbering

Nightfall numbers DMX in two places:

- **Console universes** are where fixtures are assigned with **Assign Console DMX**. They are internal to Nightfall; a console universe sends nothing on its own.
- **Wire universes** are the universe numbers an output transport (sACN, Art-Net, USB) actually sends to the network or a device.

A console universe reaches the network only through an explicit console-to-transport binding in [Patch](patch.md). For example, `patch console:2 @ sacn:10` sends console universe 2's channels as sACN universe 10. A fixture can also be patched directly to a transport, such as `patch fix 12 @ artnet:1.1`, without needing a console universe. On the wire, a direct fixture binding wins over a console universe routed to the same channels, and an input passthrough wins over both, so a wire universe can differ from the console universe routed to it.

## Transport select

With **Output** selected, the **Transport** select chooses which numbering the universe tabs use:

- **Console** lists console universes by their console number. It is listed whenever fixtures or channels occupy console universes, and on its own when nothing is being output at all.
- Each output transport lists the frames it actually sends, numbered by wire universe. Broadcast output appears as **sACN** or **Art-Net**, while unicast targets and USB devices get their own entries, such as `sACN → 10.0.0.4` or `USB (<device>)`.

Use Console to check a fixture's assigned channels, and a transport view to check what a node or device receives. If a console universe has values that no transport view carries, it has no console-to-transport binding.

With **Input** selected, the select lists the transports receiving DMX. **External**, on by default, discards frames Nightfall itself sent that loop back to its inputs. This is an engine setting, not only a display filter: discarded frames also do not drive input bindings.

## Reading channels

Use the channel grid to check whether a fixture's channels are changing. Compare the channel range with its mode's footprint in Patch or Fixture Library. Color indicators help associate channel activity with fixture output, but a raw channel value is interpreted according to that fixture profile.

A transport view shows the frame Nightfall composes for that wire universe, not proof that a packet reached a network node or USB device. If channels change but a physical light does not, check [Patch](patch.md) bindings, [I/O Transports](io-transports.md) target status, and the light's universe/address/mode.

If channels do not change, first inspect Programmer, clip playback, and Masters. Fixtures without console DMX assignment or an output binding can still be controlled virtually without occupying channels here.
