# uDMX USB Output

This crate provides DMX output via uDMX-compatible USB devices.

## Supported Hardware

- uDMX (VID `0x16c0`, PID `0x5dc`)
- Compatible clones using the same USB identifiers

## Protocol Details

uDMX uses USB vendor control transfers to send DMX data.

### USB Control Transfer Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `bmRequestType` | Vendor, Interface | Interface recipient used for host compatibility |
| `bRequest` | `2` | `UDMX_SET_CHANNEL_RANGE` command |
| `wValue` | Channel count | Number of DMX channels to send |
| `wIndex` | `0` | Starting channel (0-indexed in USB, but DMX is 1-indexed) |
| `data` | DMX values | Array of channel values (up to 512 bytes) |

### Key Implementation Notes

1. **Interface recipient**: Use `Recipient::Interface` for vendor-specific USB control transfers.

2. **Send full 512-byte frames**: Always send complete DMX universes to maintain consistent signal timing on the DMX bus and to reset channels to zero as necessary.

3. **Rate limiting**: Limit output to ~30Hz (33ms intervals) to avoid flooding the USB device. The uDMX firmware may drop or corrupt frames if sent too quickly.

4. **Device configuration**: Some uDMX clones require explicit USB configuration (`set_configuration(1)`) before claiming the interface, while others work without it. The implementation tries without first, then falls back to setting configuration 1.

## Architecture

The implementation uses a background thread to perform USB transfers without blocking the main application loop:

```text
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  Bevy System    │────▶│  FrameSlot   │────▶│  USB Thread │
│  (15Hz output)  │     │  (latest     │     │  (blocking  │
│                 │     │   frame)     │     │   transfer) │
└─────────────────┘     └──────────────┘     └─────────────┘
```

The `FrameSlot` uses a "latest frame only" pattern: if a new frame arrives before the previous one was sent, the old frame is discarded. This prevents latency buildup when USB transfers are slower than the frame rate, similar to how video conferencing apps handle network congestion.

## Timing Considerations

The uDMX protocol imposes specific timing constraints to ensure reliable operation:

- **Maximum Refresh Rate**: When all 512 channels are updated simultaneously, the maximum achievable refresh rate is 15Hz. For smaller updates (e.g., 256 channels), the refresh rate can increase to 30Hz.
- **Packet Size**: The refresh rate depends on the size of the data packets (USBP). Sending smaller packets (e.g., 1 channel at a time) significantly reduces the achievable refresh rate.
- **Transfer Time**: Transferring 512 channels requires more time compared to smaller packets. For optimal performance, the DMX software should transfer data in packets of USBP bytes.

These constraints are derived from the [uDMX timing documentation](https://www.illutzminator.de/udmx-timing.html?L=1).

## Troubleshooting

### USB control transfer failed

If you see repeated "uDMX USB transfer failed" warnings, the device may be in a bad state. Unplug the uDMX device and re-insert it to reset the USB connection.

## Further Reading

- [QLC+ uDMX plugin](https://github.com/mcallegari/qlcplus/tree/master/plugins/udmx)
- [anyma uDMX firmware](https://github.com/mirdej/udmx)
- [uDMX protocol documentation](https://www.anyma.ch/research/udmx/)
