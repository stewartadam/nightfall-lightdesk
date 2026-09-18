# Cues and timing

{{#include ../includes/human-review-disclaimer.md}}

A cue stores fixture attribute instructions. Cues belong to sequences and use addresses such as `1.2`: sequence `1`, cue `2`. Open a cue from Cues or from its Sequence Editor to inspect the actual stored attributes.

## Transitions

A fade moves an attribute from its current value to the incoming cue's target over time. Delay postpones that change. Fade-in and fade-out can differ, and sequence defaults provide timing when a cue does not override it. Inherited timing is different from an explicit zero: zero requests an immediate transition.

In Sequence Editor, select a cue and use Properties to inspect its timing and tracking overrides. Use the preview controls to step through transitions before assigning the sequence to a live clip. Stop preview when finished.

[Color Paths](color-paths.md) choose the route between colors. An assignment on cue `1.2` controls the transition **into** that cue, not the transition out of it.

## Cue triggers

New cues default to **Follow Previous**, which advances when the preceding cue finishes its delays and fades. Use **Manual** on a cue that should wait for Go. **After Delay** measures from the preceding cue's start; **At** schedules against the sequence start. Select a cue in Sequence Editor and change Trigger in Properties.

## Tracking

Tracking determines what happens to attributes that a cue does not explicitly change. In a tracking sequence, earlier values can continue into later cues. Consequently, deleting an instruction is different from storing a value of zero. Review sequence tracking mode and per-cue overrides when a look depends on earlier cues.

The Sequence Editor's tracking preview helps distinguish values stored in the cue from values inherited through playback. Cue Editor is the place to inspect the cue's own instructions. When troubleshooting unexpected values, compare both views and inspect Layers.

## Cue parts

A cue may have multiple parts so different subsets of fixtures or attributes can use different timing. Expand the cue's parts in Sequence Editor, select a part, and open its part editor. Part-specific settings override inherited timing for that part. Review conflict indicators when more than one part addresses the same fixture attribute.

## Setup and release

Sequences have setup and release programming as well as numbered cues. Setup prepares the sequence; release controls how its contribution leaves output. Stopping a clip may therefore involve a release transition rather than an instant change. Use Status Display to distinguish playing and releasing instances.

## Cues, groups, and blueprints

Use cues for looks in playback order, groups for reusable fixture selections, and blueprints for shared attribute values. The first-release UI calls its reusable value objects **Blueprints**; use that panel when looking for palette-style workflows.
