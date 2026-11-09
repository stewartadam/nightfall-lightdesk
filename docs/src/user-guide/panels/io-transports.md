# I/O Transports

{{#include ../../includes/human-review-disclaimer.md}}

I/O Transports configures the physical transport targets used by patch routing. Open it from the Command Palette.

## Network DMX

**Network input** and **Network output** enable the respective network DMX directions. Add an output target with a unique ID, select its protocol and delivery mode, and enter an IP when that mode requires one. Review the validation/status cell before adding it. The interface summary helps identify the available network adapters.

When several devices send the same input universe, Nightfall combines them the way lighting nodes do instead of following whichever packet arrived last. For sACN, the sender with the highest priority wins, and senders sharing that priority merge highest-takes-precedence per channel. A sender that goes quiet for 2.5 seconds, or stops its stream, drops out so the next one takes over: a backup console at a lower priority takes control when the main console stops. Art-Net carries no priority, so all Art-Net senders on a universe merge highest-takes-precedence, and one that stays quiet for 10 seconds drops out.

Art-Net and sACN targets are destinations for DMX data. Connect them to the appropriate console channels through [Patch](patch.md) DMX routes. A configured target does not by itself route every universe to it. Check send failures and output status when diagnosing a destination.

### Universe sync

Nightfall sends every output universe once per output cycle, one after another. Each node applies its universe as soon as the packet arrives, so a pixel effect spread over several universes can briefly show parts of two different frames. Sync fixes this on nodes that support it. Nightfall sends a sync packet after each cycle, and those nodes hold new data until it arrives, then update all their outputs at once. Turn it on in **Settings > Network > Output**:

- **Art-Net sync** broadcasts an ArtSync packet on the output interface's subnet after each cycle. Art-Net only allows ArtSync as a broadcast, so it doesn't reach nodes behind a router. Nodes without sync support ignore it. A node that supports it goes back to applying data on arrival a few seconds after ArtSync stops.
- **sACN sync** marks sACN data for synchronization on the **sACN sync universe** (1 by default) and sends the sync packet there. Receivers join that universe on their own. Unicast destinations get their own copy of the sync packet.

Leave sync off unless your nodes support it. A receiver that supports sync holds data until the sync packet arrives, so if the network drops sync packets, for example when a switch filters the sync universe's multicast group, its output freezes or stutters.

## External control

**External control** allows remote clients to reach the engine's control interface. It starts off. When enabled, **Interface** defaults to **All**; choose a specific IPv4 network interface to limit where remote clients can connect. Local access through `127.0.0.1` stays available.

Changes apply immediately and connected clients may reconnect. If a selected adapter is missing, the engine stays accessible locally and shows an error instead of opening every interface. These are settings for this computer, separate from the showfile, so loading a show does not enable external control. Enable remote access only on a trusted network.

### Open on another device

While External control is on, the section lists a link for each network address another device can use, such as `http://192.168.1.20:3030/`. Select a link to copy it. Point at the QR code button, or select it on a touch screen, to show a QR code. Scanning it opens Nightfall on the phone or tablet and pairs it in one step, because the code also carries the PIN. A copied link leaves the PIN out, so whoever opens it still has to enter the PIN.

When developing Nightfall, the link points at the Vite dev server, which only accepts other devices when started with `--host`.

### Pairing PIN

A phone, tablet or other computer must enter the **Pairing PIN** shown under External control before it can control the show. The computer running Nightfall never needs it. Each device enters the PIN once: it stays paired, and reconnects on its own after a network drop, until Nightfall restarts. The PIN stays the same until Nightfall restarts or you select **New PIN**, which also signs out every paired device. A backup server and its primary stay paired with each other across restarts, see [Backup server](#backup-server), but **New PIN** on either computer signs that pair out too. After five wrong PINs, a device must wait before trying again, and the wait grows with each further miss.

The PIN keeps casual visitors on your network out; it does not protect against an attacker on it. Nightfall serves other devices over plain HTTP, so anyone who can watch network traffic can capture the PIN or a paired device's session and take control. Use External control only on networks you trust.

## Backup server

A backup server is a second computer running Nightfall that keeps a copy of the show on the primary computer, ready to take over if the primary fails.

To set one up:

1. On the primary, turn on **External control** and note its address and **Pairing PIN**.
1. On the backup, open the **Showfiles** dialog, which also appears when Nightfall starts, and enter the primary's address, such as `192.168.1.20:3030`, under **Follow a primary**. Use the port the primary's backend listens on.
1. Enter the primary's PIN and select **Follow primary**. A primary on the same computer does not need a PIN.

The backup first checks that the primary answers and accepts the PIN. If it does not, the backup stays as it was and says why, such as a wrong PIN or an address it cannot reach. Once it accepts, the two computers share a key that keeps them paired with each other, so neither needs a PIN again, even after a restart or a takeover. Only **New PIN** on either computer ends that.

While it follows the primary, the backup:

- Copies the primary's live show, including unsaved changes, within a few seconds of each change.
- Follows what the primary is playing: running clips and their cues, levels and speeds, the tempo and its beat, timeline playback, master levels, faders and the programmer. Clip, fader, master, tempo, timecode and programmer changes made on the primary's screens, keyboard and controllers reach the backup as they happen, and the backup also checks its playback against the primary's about twice a second. After a show change is copied, the backup picks playback up again where the primary is.
- Keeps its timeline audio silent until it takes over.
- Sends sACN one priority below the show's **sACN priority**, so sACN receivers listen to the primary while both are sending, and switch to the backup on their own if the primary's stream stops.
- Mutes Art-Net and USB DMX, which have no priority to let the primary win.
- Shows a banner on every connected device and refuses changes made there, including MIDI and OSC controllers mapped in the show. Panel layouts can still be arranged.
- Copies assets the show uses from outside its folder, such as audio files, so the backup can play them after it takes over.

The backup loads each copy as a working draft under the primary's showfile name, replacing the backup's own unsaved draft of a show with that name. The saved showfile on the backup is not changed.

To take over, select **Take over** in the banner or under **Backup server**. The backup stops following the primary and outputs the copied show at the show's own priority on every transport. If the primary is still running, the backup asks it to step down, and within a few seconds it becomes the backup's backup, so the two never keep sending the same universes at the same priority.

To stop being a backup without taking over, select **Stop following**, or open or create a show from the **Showfiles** dialog. **Stop following** keeps the copied show and starts sending its output, but does not ask the primary to step down. Opening a show replaces the copied show.

The backup role is a setting for this computer, separate from the showfile, and stays in place after a restart: the backup follows its primary again and loads its show without asking which show to open. The two computers stay paired with each other across restarts. If the banner says the primary needs its pairing PIN again, for example after **New PIN**, or because the primary paired a different backup, enter its PIN under **Backup server** and select **Pair again**.

When you take over, the backup keeps playing what the primary was playing. While the backup loads a newly copied show, its banner says it is loading the primary's show.

### Automatic takeover

The backup checks on the primary twice a second. When **Take over automatically** is on, which it is by default, the backup takes over on its own once the primary has not answered for 3 seconds. **Backup server** then says when it took over. If the backup receives sACN on a universe the primary sends, it does not take over while the primary's sACN still arrives, since the primary is then still running and only the network between the two computers failed.

A backup only takes over on its own after it has reached the primary and loaded its show since it last started.

The top of **Backup server** says what this computer is and how its partner is doing:

- **Backup**: the primary it follows and whether it is in step.
- **Primary**: the backup that follows it, and whether that backup is in step, not in step since a given time, or unreachable. If the backup is also sending as a primary, a warning says both computers are sending output; on the one that should stop, open the **Showfiles** dialog and follow the other as its primary.
- **Standalone**: no backup follows this computer.

A takeover, and an old primary stepping down, also show a message on every connected device. If a device loses its connection to the primary, the connection message offers **Open the backup**, which opens the backup's address.

When the old primary comes back, the computer that took over asks it to step down within a few seconds. The old primary also checks its backup before sending anything, when it can reach it. Either way, it becomes the backup's backup: it stays silent, refuses changes, and follows the new primary. It needs no PIN for this, since the two still share their key, but it can only reach the new primary while **External control** is on there. To swap the roles back, take over on the old primary.

If the backup itself loses the network, it cannot tell that apart from the primary failing and takes over too. When the network returns, the computer that took over last keeps the show, and the other steps down. Turn off **Take over automatically** if you would rather decide every takeover yourself.

## USB

Choose a detected USB device for an output target, give the target a unique ID, and enable **USB output** when ready. Review Missing device or duplicate-device status before attempting output. If no device is listed, check the physical connection and host access to the device.

Nightfall supports these USB DMX interfaces:

- **uDMX** and compatible clones. The built-in `udmx` target uses the first uDMX it finds.
- **Enttec DMX USB Pro** and compatible clones. These appear as an FTDI USB serial adapter. Add a target for the device; Nightfall checks whether it is a USB Pro before sending DMX to it.
- **Open DMX** dongles (Enttec Open DMX USB and clones such as the DoReMiDi USB-DMX). These also appear as an FTDI USB serial adapter. An FTDI device that does not answer as a USB Pro is driven as Open DMX, so only select one that is a DMX interface, not a generic USB serial cable.

A target remembers both the serial number and the USB port of its device. Some clones all ship with the same serial number; keep each of those plugged into the same USB port (and hub) so every target finds its own dongle. A device whose serial number is unique still follows its target to another port.

Keep physical output off while rehearsing changes that should only affect the visualizer. Test one fixture and destination first, then expand the routing. Use [Console DMX](console-dmx.md) to separate programming problems from transport problems.
