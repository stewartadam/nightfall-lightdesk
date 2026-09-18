# Color Paths

{{#include ../includes/human-review-disclaimer.md}}

Color paths control how a fixture moves between two colors during a fade. They are useful when the straight-line or fixture-native fade passes through colors you do not want, such as a white flash, a muddy middle color, or the wrong side of a hue wheel.

A color path is evaluated at playback time from the actual start color to the incoming cue's destination color. It is not a stored list of absolute color values, so tracking changes, manual output, and edits to earlier cues can change the start color while keeping the same path assignment.

## Built-In Paths

New showfiles include these built-in color paths:

| ID | Name | Behavior |
| --- | --- | --- |
| `1` | RGB | Interpolate directly through RGB emitter space. |
| `2` | HSV | Interpolate hue, saturation, and value. This is often useful for hue-wheel style fades. |
| `3` | CMY | Interpolate through cyan, magenta, and yellow components. |

Built-in paths can be selected and assigned, but they are read-only. Create a custom path when you need a reusable path with different labels or editable settings.

## Assignment Semantics

Color path assignment belongs to the destination cue or fixture default, not to the source cue.

For example, if cue `1.2` has color path `2` assigned, then the transition from cue `1.1` into cue `1.2` uses HSV interpolation. The transition from cue `1.2` into cue `1.3` is controlled by cue `1.3`, or by the fixture default if cue `1.3` has no explicit color path.

Resolution order is:

1. The color path assigned to the incoming cue's color instruction.
2. The fixture or fixture-element color path default.
3. Native fixture fade behavior.

Color paths apply only to color-capable instructions, such as RGB, RGBW, RGBA, CMY, and color-mix emitter attributes. Assigning a path to a cue with no supported color instruction has no effect.

## Cue Usage

Assign a path to a cue when that cue's destination color needs a specific route:

```text
cue 1.2 path 2
```

This makes the fade into cue `1.2` use the HSV path.

Clear the explicit cue assignment with:

```text
cue 1.2 path clear
```

After clearing, the cue falls back to the fixture default or native behavior.

## Fixture Defaults

Assign a path to a fixture when most fades for that fixture should use the same route:

```text
fixture 301 path 3
```

Fixture elements can also have defaults:

```text
fixture 301.2 path 3
```

Clear a fixture default with:

```text
fixture 301 path clear
```

Fixture defaults are useful for lights whose native color fade is rarely the desired operator behavior. Cue assignments still override fixture defaults when a specific cue needs a different route.

## Managing Custom Paths

Use path IDs outside the built-in range for custom paths:

```text
store path 101 label "No Green"
cp path 101 102
rm path 102
```

`path` is the shorthand object name for `color-path`, which is also accepted:

```text
store color-path 101
cp color-path 101 102
```

The generic move syntax renumbers a path and updates cue and fixture-default references:

```text
mv path 101 202
```

Built-in paths `1` through `3` cannot be relabeled, overwritten, duplicated into, or removed.

## Timing Controls

Custom paths can adjust how the transition behaves over time:

- **Curve** changes the shape used to sample the path.
- **In Color** controls when the destination color starts entering the fade.
- **Out Color** controls when the source color leaves the fade.
- **Brightness** controls the midpoint brightness of the fade without changing either endpoint.

These controls affect the transition into the destination cue. They do not rewrite the cue's stored start or destination color values.
