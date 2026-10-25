# Fixture Library

{{#include ../../includes/human-review-disclaimer.md}}

Fixture Library lists the fixture definitions available to the engine. Open it from the Command Palette and open **Properties** beside it.

Search or filter by make and model. Select a definition, then inspect its modes, channel count, details, and **Mode Parameters** in Properties. The mode must match the mode configured on the physical fixture; similarly named modes can have different channel layouts.

Use the preview to check the attributes you need before patching. A fixture with color channels may also require intensity or shutter parameters to emit light. Once you have chosen a definition, use [Patch](patch.md) to create instances in the show.

## Search GDTF Share

[GDTF Share](https://gdtf-share.com) is the shared online library of GDTF fixture definitions. It needs a free account: sign in under **Settings > Network > GDTF Share** on the computer running Nightfall. Every device connected to that computer then uses the same account.

Select **Search GDTF Share** in the toolbar and type a make, model, or mode name. Select a result to see its revision and modes, then select **Install** to download it into the library. Results already in the library say **In library**; select **Show library copy** to inspect the copy you have, or **Install this revision** to add the online revision next to it.

The patch wizard has the same search: switch its fixture list from **In library** to **GDTF Share**, or select **Search GDTF Share** when no library fixture matches your filter. Installing from the wizard selects the new fixture so you can continue patching.

Nightfall saves a copy of the GDTF Share list, so searching works without an internet connection once it has been fetched. The list refreshes itself daily; select the refresh button beside the search field to fetch it now. Installing still needs a connection. GDTF Share is not available in the browser demo.

## If the list is empty

Use **Upload fixture** in the toolbar to import a `.gdtf` or Open Fixture Library (OFL) `.json` definition. Select the imported fixture and inspect its modes before patching. The library reads installed fixture data; it is separate from the fixtures already stored in a show. Fixture data belongs in the application's `fixtures` directory:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/com.nightfall.nightfall/fixtures/` |
| Linux | `~/.local/share/nightfall/fixtures/` |
| Windows | `%APPDATA%\nightfall\nightfall\data\fixtures\` |

Use Nightfall-compatible fixture definitions. For source builds, `NIGHTFALL_DATA_DIR` changes the application data root, so inspect that location if the expected library is missing. Restart the engine after installing definitions if they have not appeared. A saved show's fixture data and an installed library version may differ; review any version-mismatch prompt when adding or morphing fixtures.
