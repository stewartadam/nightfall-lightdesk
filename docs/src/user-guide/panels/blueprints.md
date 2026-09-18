# Blueprints

{{#include ../../includes/human-review-disclaimer.md}}

Blueprints holds reusable attribute values for palette-style programming. Open it from the Command Palette. Use **New Blueprint** to create an empty blueprint with an ID and label. Build the desired values in Programmer, then use **Store/Update from Programmer** on that blueprint to fill or update it.

## Reference or copy

**Recall Blueprint** recalls referenced values. Programming that retains those references can follow later blueprint changes. **Recall Blueprint Absolute** uses concrete values instead, useful when a look should remain independent of later edits.

Use clear labels such as Warm white or Stage left position, and inspect Attributes and Refs in the list. The context menu's Dependents entry helps reveal objects using the blueprint; [References](references.md) gives a broader dependency view.

Before updating a shared blueprint, inspect its dependents and compare resulting playback. Updating reusable values can affect multiple cues. Save the showfile after the intended changes are confirmed.
