# FX Editor

{{#include ../../includes/human-review-disclaimer.md}}

FX Editor configures an effect's selection, affected attributes, and movement over time. Open a waveform effect from **FX List**. Step FX and module FX entries do not currently open in this editor.

For waveform effects, choose a waveform such as Sine, Triangle, Sawtooth, Square, or Pulse and set its parameters. Choose the fixture selection and attributes explicitly. Relative values offset another value; absolute values specify the effect's own targets.

Changes are local to the editor until you choose **Save**. Save the effect before assigning it to a clip, and then save the showfile to persist the show. Closing a dirty editor prompts before discarding its changes.

Use **Toggle FX preview** to observe the result in Fixtures and 3D Visualizer. Clear unrelated programmer instructions first and stop preview when finished. For repeated operation, assign the effect as the source of a [Clip](clips.md).

Selection order changes how effects distribute across a rig. Use [Selection Inspector](selection-inspector.md) to check complex selections.
