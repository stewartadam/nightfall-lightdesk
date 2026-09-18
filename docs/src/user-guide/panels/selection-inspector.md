# Selection Inspector

{{#include ../../includes/human-review-disclaimer.md}}

Selection Inspector displays the structure and order of a fixture selection. Open it from the Command Palette when working with groups, multi-element fixtures, or distributed effects.

The expression input accepts structured selections, for example `Fixture 1>8 | Grid 4 | Wings 2`. Choose **Apply** to update the programmer selection, then inspect the resulting arrangement and ordering. **Reset** restores the expression from the current selection. The panel exposes selection structure and transformations that can be difficult to infer from a flat fixture list.

Use this view to find unexpected gaps, repeated entries, or ordering before storing a group or using a selection in FX. Selections based on physical position need useful fixture placement information; explicit grid and wing transforms describe selection structure independently.

Flattening a structured selection discards its structure. Read the confirmation before doing so, particularly if later changes should preserve wings or grid relationships. For ordinary look programming, return to [Programmer](programmer.md).
