# Color Paths

{{#include ../../includes/human-review-disclaimer.md}}

Color Paths manages the interpolation routes used for color fades. Open it from the Command Palette and select a path to inspect its properties.

The built-in RGB, HSV, and CMY paths have IDs 1, 2, and 3. They are read-only. Create a custom path when you need editable curve, In Color, Out Color, or Brightness settings, and label it by the intended result.

Assign a path to the incoming cue's color instructions or as a fixture/element default. A cue assignment takes precedence over the fixture default. Paths affect the route through a fade, not the endpoint color stored in the cue.

Test the result from more than one starting color: playback uses the actual start color, so a path is not a fixed sequence of colors. See [Color Paths](../color-paths.md) for assignment commands, built-in behavior, and custom path management.
