# Console DMX

{{#include ../../includes/human-review-disclaimer.md}}

Console DMX displays Nightfall's internal DMX universe values. Open it from the Command Palette and choose the universe you want to inspect.

Use the channel grid to check whether a fixture's assigned channels are changing. Compare the channel range with its mode's footprint in Patch or Fixture Library. Color indicators help associate channel activity with fixture output, but a raw channel value is interpreted according to that fixture profile.

This panel shows console channels, before the complete journey to hardware. Values here do not prove a packet reached a network node or USB device. If the channels change but a physical light does not, check [Patch](patch.md) bindings, [I/O Transports](io-transports.md) target status, and the light's universe/address/mode.

If channels do not change, first inspect Programmer, clip playback, and Masters. Fixtures without console DMX assignment can still be controlled virtually without occupying channels here.
