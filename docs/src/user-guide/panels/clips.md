# Clips

{{#include ../../includes/human-review-disclaimer.md}}

Clips provides reusable playback definitions and control slots. Open it from the Command Palette. Use **Add clip** to create an ID and label, then select the clip and open Properties.

## Configure and play

Choose a source kind and an existing source object: a Sequence or an FX variant. Set priority and other playback options in Properties. The source is a reference; renaming a clip does not create a copy of its sequence or effect.

Right-click a clip for **Start Clip**, **Stop Clip**, and **Show Properties**. The State column distinguishes Active from Idle. For sequence playback, Go advances cues; starting and advancing are separate operations.

The controls area accepts drag-and-drop assignments so frequently used clips have dedicated controls. It can also host master controls. Check each control's label before operating it.

Use [Status Display](status-display.md) to inspect running instances and [Layers](layers.md) to see their contribution to fixtures. Clear Programmer before evaluating playback. After changing a clip's source, stop its existing playback and start again to verify the intended definition.
