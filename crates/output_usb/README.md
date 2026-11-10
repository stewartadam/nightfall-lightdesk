# USB DMX Output

This crate sends DMX to USB DMX interfaces. Each output target names a USB device; a process-lifetime worker writes the target's composed universe to that device on the shared output tick grid.

## Supported hardware

| Interface | USB ID | Driven through | Detection |
|-----------|--------|----------------|-----------|
| uDMX and clones | `16c0:05dc` | Raw USB vendor control transfers | USB ID |
| Enttec DMX USB Pro and clones | `0403:6001` (FTDI) | The OS serial driver | USB ID, then a widget parameters probe |

The automatic `default` device selector, used by the built-in `udmx` target, only takes uDMX interfaces. FTDI chips also sit in Open DMX dongles and generic USB serial adapters, so an FTDI device is only driven when a target selects it explicitly, and only after it answers the USB Pro probe.

## Code layout

| Module | Role |
|--------|------|
| `discovery` | Lists visible devices of every supported family and resolves saved selectors to them |
| `driver` | Maps USB IDs to interface families and dispatches to the protocol drivers |
| `udmx` | uDMX protocol driver |
| `usb_pro` | Enttec DMX USB Pro protocol driver |
| `serial_port` | Finds the OS serial port of an FTDI USB device |
| `service` | Output worker, open-device bookkeeping, and hotplug watcher |
| `output` | ECS system that hands composed frames to the worker |
| `device_list` | Device list resource and its client feed |

To add a protocol, add a driver module with an `open` and a `write`, a variant to `UsbDmxConnection`, and, for a new USB ID, a family in `UsbDmxFamily::from_usb_id`, which discovery, hotplug, and opening all use. When the new protocol shares a family's USB ID, as Open DMX shares the FTDI ID, try it in that family's branch of `UsbDmxConnection::open` after the probes that can tell it apart.

```text
┌──────────────┐     ┌────────────────────┐     ┌──────────────────────────┐
│ output system│────▶│ UsbDmxOutputClient │────▶│ worker (tick grid)       │
│ (Render)     │     │ (latest frames)    │     │  ├─ uDMX: changed runs   │
└──────────────┘     └────────────────────┘     │  └─ USB Pro: DMX packet  │
                                                └──────────────────────────┘
```

The client keeps only the latest published frames. The worker writes them on every output tick and skips a device whose universe has not changed since its last successful write. A write that runs past the next tick makes the worker skip that tick instead of queueing frames. Devices are opened by one USB enumeration per retry, and closed again once no published frame names them, so turning USB output off or removing a target releases the device to other programs.

## uDMX protocol

uDMX uses USB vendor control transfers to send DMX data.

| Parameter | Value | Description |
|-----------|-------|-------------|
| `bmRequestType` | Vendor, Interface | Interface recipient used for host compatibility |
| `bRequest` | `2` | `UDMX_SET_CHANNEL_RANGE` command |
| `wValue` | Channel count | Number of DMX channels to send |
| `wIndex` | Start channel | Zero-based first channel |
| `data` | DMX values | Channel values |

- The uDMX firmware needs roughly 66 ms to take all 512 channels, which would cap whole-universe output near 15 Hz ([uDMX timing](https://www.illutzminator.de/udmx-timing.html?L=1)). The driver writes only the runs of channels that changed, merging runs fewer than 16 channels apart, and writes the whole universe only when the device's contents are unknown.
- Some clones need configuration 1 set before the interface can be claimed, while others reject the request, so it is only set when the first claim fails.

## Enttec DMX USB Pro protocol

The USB Pro runs its own firmware behind an FTDI FT245R and keeps transmitting the last universe it received. Every message is framed:

| Byte | Value |
|------|-------|
| 0 | `0x7E` start of message |
| 1 | Label |
| 2-3 | Data length, LSB first |
| 4.. | Data |
| last | `0xE7` end of message |

| Label | Message | Use |
|-------|---------|-----|
| `3` | Get widget parameters | Probe. The request carries the user configuration length (`0`); the reply carries the firmware version, break time, mark-after-break time, and output rate. |
| `6` | Output only send DMX packet | Start code `0` followed by all 512 channels |

The driver opens the device's serial port, sends the label 3 request, and waits up to 300 ms for the reply, skipping other messages such as received DMX. A device that does not answer is reported as unsupported and is not probed again until it is unplugged, since each probe writes to the device and blocks the worker. A packet the port only partly took is finished before the next one starts, so the widget never sees a cut-off frame. After each DMX packet the driver discards anything the widget sent back unasked.

Enttec's DMX USB Pro API specification documents the full message set.

## Troubleshooting

### uDMX USB transfer failed

Repeated "uDMX USB transfer failed" warnings mean the device may be in a bad state. Unplug the uDMX and plug it in again to reset the USB connection.

### USB serial device did not answer as an Enttec DMX USB Pro

The selected FTDI device is not a USB Pro, or another program was using its serial port during the probe. Close other lighting software, then unplug the device and plug it in again to probe it.

### USB DMX device is present but could not be opened

The device is attached but its port could not be opened, usually because another program holds it or the OS driver is still binding. The worker keeps retrying every 500 ms and logs this once per target.

## Further reading

- [QLC+ uDMX plugin](https://github.com/mcallegari/qlcplus/tree/master/plugins/udmx)
- [anyma uDMX firmware](https://github.com/mirdej/udmx)
- [uDMX protocol documentation](https://www.anyma.ch/research/udmx/)
- [OLA USB Pro plugin](https://github.com/OpenLightingProject/ola/tree/master/plugins/usbpro)
