# Fixture Library

{{#include ../../includes/human-review-disclaimer.md}}

Fixture Library lists the fixture definitions available to the engine. Open it from the Command Palette and open **Properties** beside it.

Search or filter by make and model. Select a definition, then inspect its modes, channel count, details, and **Mode Parameters** in Properties. The mode must match the mode configured on the physical fixture; similarly named modes can have different channel layouts.

Use the preview to check the attributes you need before patching. A fixture with color channels may also require intensity or shutter parameters to emit light. Once you have chosen a definition, use [Patch](patch.md) to create instances in the show.

## If the list is empty

Use **Upload fixture** in the toolbar to import a `.gdtf` or Open Fixture Library (OFL) `.json` definition. Select the imported fixture and inspect its modes before patching. The library reads installed fixture data; it is separate from the fixtures already stored in a show. Fixture data belongs in the application's `fixtures` directory:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/com.nightfall.nightfall/fixtures/` |
| Linux | `~/.local/share/nightfall/fixtures/` |
| Windows | `%APPDATA%\nightfall\nightfall\data\fixtures\` |

Use Nightfall-compatible fixture definitions. For source builds, `NIGHTFALL_DATA_DIR` changes the application data root, so inspect that location if the expected library is missing. Restart the engine after installing definitions if they have not appeared. A saved show's fixture data and an installed library version may differ; review any version-mismatch prompt when adding or morphing fixtures.
