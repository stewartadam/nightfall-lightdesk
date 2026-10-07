# I/O Transports

{{#include ../../includes/human-review-disclaimer.md}}

I/O Transports configures the physical transport targets used by patch routing. Open it from the Command Palette.

## Network DMX

**Network input** and **Network output** enable the respective network DMX directions. Add an output target with a unique ID, select its protocol and delivery mode, and enter an IP when that mode requires one. Review the validation/status cell before adding it. The interface summary helps identify the available network adapters.

Art-Net and sACN targets are destinations for DMX data. Connect them to the appropriate console channels through [Patch](patch.md) bindings. A configured target does not by itself route every universe to it. Check send failures and output status when diagnosing a destination.

## External control

**External control** allows remote clients to reach the engine's control interface. It starts off. When enabled, **Interface** defaults to **All**; choose a specific IPv4 network interface to limit where remote clients can connect. Local access through `127.0.0.1` stays available.

Changes apply immediately and connected clients may reconnect. If a selected adapter is missing, the engine stays accessible locally and shows an error instead of opening every interface. These are settings for this computer, separate from the showfile, so loading a show does not enable external control. Enable remote access only on a trusted network.

### Open on another device

While External control is on, the section lists a link for each network address another device can use, such as `http://192.168.1.20:3030/`. Select a link to copy it. Point at the QR code button, or select it on a touch screen, to show a QR code. Scanning it opens Nightfall on the phone or tablet and pairs it in one step, because the code also carries the PIN. A copied link leaves the PIN out, so whoever opens it still has to enter the PIN.

When developing Nightfall, the link points at the Vite dev server, which only accepts other devices when started with `--host`.

### Pairing PIN

A phone, tablet or other computer must enter the **Pairing PIN** shown under External control before it can control the show. The computer running Nightfall never needs it. Each device enters the PIN once: it stays paired, and reconnects on its own after a network drop, until Nightfall restarts. The PIN stays the same until Nightfall restarts or you select **New PIN**, which also signs out every paired device. After five wrong PINs, a device must wait before trying again, and the wait grows with each further miss.

The PIN keeps casual visitors on your network out; it does not protect against an attacker on it. Nightfall serves other devices over plain HTTP, so anyone who can watch network traffic can capture the PIN or a paired device's session and take control. Use External control only on networks you trust.

## USB

Choose a detected USB device for an output target, give the target a unique ID, and enable **USB output** when ready. Review Missing device or duplicate-device status before attempting output. If no device is listed, check the physical connection and host access to the device.

Keep physical output off while rehearsing changes that should only affect the visualizer. Test one fixture and destination first, then expand the routing. Use [Console DMX](console-dmx.md) to separate programming problems from transport problems.
