# Supported controllers

{{#include ../includes/human-review-disclaimer.md}}

Nightfall recognizes the controllers below by their MIDI port name and lights their buttons to show what each binding is doing. You pick LED colors by name, such as "Green" or "Amber flashing", instead of typing the numbers the controller expects. Controllers not listed here still work. Their bindings run as usual, and you can turn on LED feedback and enter LED values by hand.

None of these profiles has been fully checked on real hardware yet. Each one is built from the manufacturer's documentation and the [QLC+](https://www.qlcplus.org/) input profiles, so a color or port name might be wrong. For controllers nobody on the team owns, LED feedback stays off until you turn on **LED feedback** beside the device in **MIDI Input**.

| Controller | Tested on hardware | LED feedback starts | Notes |
|---|---|---|---|
| Novation Launchpad (original), Launchpad S, Launchpad Mini mk1 and mk2 | Not yet, original Launchpad on hand | On | The Launchpad S and Mini use the same protocol and port name, so they share the profile. |
| Novation Launchpad MK2 | No | Off | Pads use the Session layout: notes 11 to 88, with the top row as controllers 104 to 111. |
| Novation Launchpad Mini MK3 | No | Off | Map the **LPMiniMK3 MIDI** port (**MIDIIN2** on Windows), not **DAW**, with the Launchpad in Programmer mode. To switch modes, hold **Session**, then press the orange scene button. |
| Akai APC mini (original) | No | Off | Green, red, and yellow, steady or blinking. |
| Akai APC mini mk2 | No | Off | Pads light at full brightness. Track and scene buttons have one LED color each. |
| Akai APC40 mkII | No | Off | While LED feedback is on, the APC40 runs in Ableton Live mode so Nightfall controls its LEDs. |
| Intech Grid modules | Not yet, button and encoder modules on hand | On | Enable MIDI receive for each control in Grid Editor, and set its color there. |

The Launchpad MK2, Launchpad Mini MK3, APC mini mk2, and APC40 mkII share one 128-color palette. Their pads offer steady colors only, because these controllers choose blinking by MIDI channel.

## Help test a controller

If you own one of these controllers:

1. Connect it and open **MIDI Input**. Under **Connected MIDI Devices**, check that the controller's name appears beside its port. If it does not, the port name does not match the profile.
2. Turn on **LED feedback** for the device, bind a few buttons, and check that each LED color matches its name.
3. Report the port name and anything that looked wrong, so the profile can be marked as tested or fixed.
