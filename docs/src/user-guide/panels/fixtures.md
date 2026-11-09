# Fixtures

{{#include ../../includes/human-review-disclaimer.md}}

Fixtures shows patched fixtures and their current attribute values. Open it from the Command Palette to monitor the result of programmer values and playback together.

Select fixtures here when building a look, then use the command input or Programmer to set attributes. Fixture-wide rows and element rows let you work at different levels of a multi-cell light. Use the row-type and attribute filters to focus the table, and the column menu to expose relevant attributes.

Compare this panel with [Programmer](programmer.md): Programmer shows working instructions, while Fixtures shows current fixture state. A value can appear in Fixtures even when Programmer is empty because a running clip contributes it. [Layers](layers.md) helps identify the source.

A **P** tag marks a parked value, which holds over all playback until you unpark it. Right-click a value cell and choose **Park** to hold it at its current output, or right-click a parked cell and choose **Unpark** to release it. On a fixture-wide row, **Park** holds that attribute on every element. On a fixture-wide row, **Unpark all elements** releases every parked element of that attribute. Properties for this panel lists every parked parameter in the show.

Turn on **Parked** in the toolbar to show only parked fixtures and the attributes they have parked, with their output values. While anything is parked, the status bar shows how many parameters are parked; click it to open Fixtures with **Parked** on. See [Park](../commands.md#park).

Use [Patch](patch.md) to change profile, mode, placement, and routing. If a fixture seems missing, clear table filters and check its ID in Patch before adding a duplicate.
