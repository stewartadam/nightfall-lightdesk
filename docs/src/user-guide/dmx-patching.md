# Patching fixtures with DMX

{{#include ../includes/human-review-disclaimer.md}}

Patching tells Nightfall which lights are in your rig and which DMX channels control each one. You patch a fixture by choosing its definition and mode, giving it a fixture ID, and assigning it a universe and start address.

## How DMX addresses work

DMX sends lighting data in universes. A universe holds 512 channels, numbered as addresses 1 to 512. Each channel carries one value from 0 to 255, such as the level of a red LED or the position of a pan motor.

A fixture listens to a block of consecutive channels that begins at its start address. The size of the block is the fixture's channel count, which depends on its mode. For example, a fixture with a 48-channel mode at universe 1, address 481 uses addresses 481 to 528. Address 528 does not exist, so this fixture doesn't fit and needs a lower start address or another universe.

Two fixtures that share a channel react to the same value, so give each fixture its own block. Set the same mode and start address on the physical light that you set in Nightfall. If they differ, commands change the wrong attribute or the wrong light.

## Fixture IDs and addresses are separate

The fixture ID is the number you type to select a light, as in `fix 701`. It identifies the fixture in commands, groups, and cues, and doesn't depend on where its DMX starts. You can repatch a fixture to a new address without changing its ID, and your programming keeps working.

Choose ID ranges that make sense for your rig, for example 101 to 112 for front washes and 201 to 206 for moving heads.

## Patch new fixtures

1. Open **Patch** from the Command Palette.
1. In the **Fixtures** view, select **Add fixture** (+) to open the wizard.
1. Filter the library and select a fixture definition, then select **Next**. If the fixture is not in the library, switch to **GDTF Share** to [search and install it](panels/fixture-library.md#search-gdtf-share).
1. Select the mode set on the physical light, then select **Next**.
1. Set **Quantity** and **First fixture ID**. The wizard numbers the other fixtures after the first one. Leave **First fixture ID** empty to use the next ID after the highest one in the show.
1. Keep **Assign Console DMX** selected and set the universe and start address under **Patch**. The wizard starts on the first universe and address with room for every new fixture. Select **Next available** to find that spot again after changing the quantity or mode. Each next fixture starts right after the previous one.
1. Check the summary, then select **Finish**.

The new fixtures appear in the **Fixtures** view. Each one gets a DMX route to its console universe and address, listed in the **DMX Routes** view.

## Send the patch to your lights

Console universes are Nightfall's own DMX space. To reach real lights, route console universes to an output target such as sACN, Art-Net, or a USB interface. See [Patch](panels/patch.md) for routes and [I/O Transports](panels/io-transports.md) for output targets.

## Related topics

- [Patch](panels/patch.md)
- [Fixture Library](panels/fixture-library.md)
- [Console DMX](panels/console-dmx.md)
- [Glossary](glossary.md)
