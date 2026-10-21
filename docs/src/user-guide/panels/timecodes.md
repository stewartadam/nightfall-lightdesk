# Timecodes

{{#include ../../includes/human-review-disclaimer.md}}

Timecodes monitors the clocks used by timelines. Open it from the Command Palette.

The table shows each timecode's ID, current time in hours/minutes/seconds/frames, and running status. Select a row to keep the clock of interest highlighted. An inactive clock can remain at its current position; an empty table means no timecodes are present in the loaded show.

## Following external timecode

Choose a timecode's **Source** and **Rate** in [Timeline](timeline.md) Properties; the change applies to every timeline sharing that timecode. A timecode can follow a timecode sender instead of the engine clock, so its timelines chase the playback deck, DAW, media server, or console sending it:

- **MIDI timecode** follows MIDI timecode (MTC) from any connected MIDI input.
- **Art-Net** follows Art-Net timecode (ArtTimeCode) arriving on the network interface used for Art-Net input. **Network input** must be enabled (see [I/O Transports](io-transports.md)).
- **LTC** follows SMPTE linear timecode arriving as audio. Pick the **Audio input** and **Channel** carrying it under the source; each LTC timecode can read its own input. **Default input** follows the system's default input device. The input opens only while the timecode is started, so the first start may ask for microphone access. If the device is missing or unplugged, the timecode shows **No signal** and reconnects within a few seconds once the device is back.

All three behave the same way:

- **Start** arms the timecode. It runs only while timecode arrives, and its timelines play and pause with the sender. **Pause** and **Stop** stop following the sender.
- When the sender locates without playing, the timecode jumps to that position and stays paused.
- If timecode stops arriving, the timecode keeps running on its own for one second to ride out a glitch, then holds its position and its timelines pause until timecode returns.
- Loops on a timeline that follows external timecode don't seek, since the sender decides the position.

The status shows **No signal** while an armed timecode is waiting for the sender, **Receiving** while timecode arrives, and **Freewheel** during a dropout. When the sender's frame rate differs from the timecode's rate, the source names the rate it sends.

The browser demo has no MIDI, network, or audio input, so external timecodes there always show **No signal**.

Configure the linked timecode from [Timeline](timeline.md) Properties and operate it with the timeline's transport controls. This panel is a monitor, not a full timecode editor.

When a timeline appears stationary, check that its linked timecode is the one running here. When two views show unexpected timing, compare their clock identities before changing action positions.
