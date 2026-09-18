# I/O Transports

{{#include ../../includes/human-review-disclaimer.md}}

I/O Transports configures the physical transport targets used by patch routing. Open it from the Command Palette.

## Network DMX

**Network input** and **Network output** enable the respective network DMX directions. Add an output target with a unique ID, select its protocol and delivery mode, and enter an IP when that mode requires one. Review the validation/status cell before adding it. The interface summary helps identify the available network adapters.

Art-Net and sACN targets are destinations for DMX data. Connect them to the appropriate console channels through [Patch](patch.md) bindings. A configured target does not by itself route every universe to it. Check send failures and output status when diagnosing a destination.

## External control

**External control** allows remote clients to reach the engine's control interface. It starts off. When enabled, **Interface** defaults to **All**; choose a specific IPv4 network interface to limit where remote clients can connect. Local access through `127.0.0.1` stays available.

Changes apply immediately and connected clients may reconnect. If a selected adapter is missing, the engine stays accessible locally and shows an error instead of opening every interface. These are settings for this computer, separate from the showfile, so loading a show does not enable external control. Enable remote access only on a trusted network.

## USB

Choose a detected USB device for an output target, give the target a unique ID, and enable **USB output** when ready. Review Missing device or duplicate-device status before attempting output. If no device is listed, check the physical connection and host access to the device.

Keep physical output off while rehearsing changes that should only affect the visualizer. Test one fixture and destination first, then expand the routing. Use [Console DMX](console-dmx.md) to separate programming problems from transport problems.
