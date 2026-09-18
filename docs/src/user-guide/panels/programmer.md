# Programmer

{{#include ../../includes/human-review-disclaimer.md}}

Programmer is the live workspace for building looks. Open it from the Command Palette; select fixtures from Fixtures or by command to populate it.

## Build a look

Set values using the command input, for example `fixture 1 @ 50`, or edit the table's attribute cells. Open Properties for the active programmer selection. Fixture-wide and element rows distinguish a whole fixture from individual cells. Empty cells on a selected row are not instructions to set those attributes to zero.

Right-click attribute cells for the available value and clear operations. Filters and hidden columns can hide programmed attributes, so review them before storing a look.

## Keep or release your work

**Store cue** saves instructions into a sequence/cue address. **Store group** saves a fixture selection. See [Storing and recalling looks](../stores.md) for overwrite behavior and reusable blueprints.

**Clear programmer** in this panel clears selection first, then values on another press. Continue until the live values are released before checking cue playback. Setting intensity to zero leaves a programmer instruction; it is different from clearing it.

If a running clip looks wrong, clear the programmer and inspect [Layers](layers.md). Store only the intended instructions, then use Save Showfile to preserve the changes.
