# I/O Transports

{{#include ../../includes/human-review-disclaimer.md}}

I/O Transports configures the physical transport targets used by patch routing. Open it from the Command Palette.

## Network DMX

**Network input** and **Network output** enable the respective network DMX directions. Add an output target with a unique ID, select its protocol and delivery mode, and enter an IP when that mode requires one. Review the validation/status cell before adding it. The interface summary helps identify the available network adapters.

When several devices send the same input universe, Nightfall combines them the way lighting nodes do instead of following whichever packet arrived last. For sACN, the sender with the highest priority wins, and senders sharing that priority merge highest-takes-precedence per channel. A sender that goes quiet for 2.5 seconds, or stops its stream, drops out so the next one takes over: a backup console at a lower priority takes control when the main console stops. Art-Net carries no priority, so all Art-Net senders on a universe merge highest-takes-precedence, and one that stays quiet for 10 seconds drops out.

Art-Net and sACN targets are destinations for DMX data. Connect them to the appropriate console channels through [Patch](patch.md) DMX routes. A configured target does not by itself route every universe to it. Check send failures and output status when diagnosing a destination.

### Universe sync

Nightfall sends every output universe once per output cycle, one after another. Each node applies its universe as soon as the packet arrives, so a pixel effect spread over several universes can briefly show parts of two different frames. Sync fixes this on nodes that support it. Nightfall sends a sync packet after each cycle, and those nodes hold new data until it arrives, then update all their outputs at once. Turn it on in **Settings > Network > Output**:

- **Art-Net sync** broadcasts an ArtSync packet after each cycle. Nodes without sync support ignore it. A node that supports it goes back to applying data on arrival a few seconds after ArtSync stops.
- **sACN sync** marks sACN data for synchronization on the **sACN sync universe** (1 by default) and sends the sync packet there. Receivers join that universe on their own. Unicast destinations get their own copy of the sync packet.

Leave sync off unless your nodes support it. A receiver that supports sync holds data until the sync packet arrives, so if the network drops sync packets, for example when a switch filters the sync universe's multicast group, its output freezes or stutters.

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

Nightfall supports these USB DMX interfaces:

- **uDMX** and compatible clones. The built-in `udmx` target uses the first uDMX it finds.
- **Enttec DMX USB Pro** and compatible clones. These appear as an FTDI USB serial adapter. Add a target for the device; Nightfall checks it is a USB Pro before sending DMX to it.

Keep physical output off while rehearsing changes that should only affect the visualizer. Test one fixture and destination first, then expand the routing. Use [Console DMX](console-dmx.md) to separate programming problems from transport problems.
