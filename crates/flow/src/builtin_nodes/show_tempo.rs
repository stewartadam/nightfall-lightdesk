// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Show tempo node: exposes the live show tempo and fires on each beat and bar.

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::runtime::FlowTriggerState;
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the show tempo node.
pub const SHOW_TEMPO_KIND: &str = "show_tempo";
/// Port id for the current tempo in BPM.
pub const SHOW_TEMPO_OUT_BPM: FlowPortId = 1;
/// Port id for the 1-based beat within the bar.
pub const SHOW_TEMPO_OUT_BEAT: FlowPortId = 2;
/// Port id for the 1-based bar count.
pub const SHOW_TEMPO_OUT_BAR: FlowPortId = 3;
/// Port id for progress through the current beat, 0 to 1.
pub const SHOW_TEMPO_OUT_PHASE: FlowPortId = 4;
/// Port id for the trigger fired on every beat.
pub const SHOW_TEMPO_OUT_ON_BEAT: FlowPortId = 5;
/// Port id for the trigger fired on every downbeat.
pub const SHOW_TEMPO_OUT_ON_BAR: FlowPortId = 6;

/// Factory for creating show tempo nodes.
pub struct ShowTempoFactory;

/// Builds one output port definition with no default value.
fn output_port(port_id: FlowPortId, name: &str, port_type: FlowPortType) -> FlowPortDefinition {
    FlowPortDefinition {
        port_id,
        name: name.to_string(),
        direction: FlowPortDirection::Output,
        port_type,
        is_optional: false,
        default_value: None,
        enum_options: None,
    }
}

impl FlowNodeFactory for ShowTempoFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: SHOW_TEMPO_KIND.to_string(),
            label: "Show Tempo".to_string(),
            category: crate::nodes::FlowNodeCategory::Event,
            ports: vec![
                output_port(SHOW_TEMPO_OUT_BPM, "BPM", FlowPortType::Number),
                output_port(SHOW_TEMPO_OUT_BEAT, "Beat", FlowPortType::Int),
                output_port(SHOW_TEMPO_OUT_BAR, "Bar", FlowPortType::Int),
                output_port(SHOW_TEMPO_OUT_PHASE, "Phase", FlowPortType::Number),
                output_port(SHOW_TEMPO_OUT_ON_BEAT, "On Beat", FlowPortType::Trigger),
                output_port(SHOW_TEMPO_OUT_ON_BAR, "On Bar", FlowPortType::Trigger),
            ],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(ShowTempoNode::default())
    }
}

/// A node that follows the show tempo and fires triggers as beats and bars pass.
#[derive(Default)]
pub struct ShowTempoNode {
    /// Whole beat counter seen on the previous evaluation, if any.
    last_beat: Option<u64>,
}

/// Adds `count` events to an output trigger port.
fn fire(output_triggers: &mut crate::nodes::FlowTriggerValues, port_id: FlowPortId, count: u64) {
    if count == 0 {
        return;
    }
    let count = u32::try_from(count).unwrap_or(u32::MAX);
    let trigger = output_triggers
        .entry(port_id)
        .or_insert(FlowTriggerState { seq: 0, count: 0 });
    trigger.seq = trigger.seq.saturating_add(count);
    trigger.count = trigger.count.saturating_add(count);
}

impl FlowNode for ShowTempoNode {
    fn execute(
        &mut self,
        _inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        output_triggers: &mut crate::nodes::FlowTriggerValues,
        ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let Some(tempo) = ctx.tempo else {
            return Ok(());
        };
        let beat = tempo.beat_position.floor() as u64;
        let beats_per_bar = u64::from(tempo.beats_per_bar.max(1));
        if let Some(last_beat) = self.last_beat
            && beat > last_beat
        {
            fire(output_triggers, SHOW_TEMPO_OUT_ON_BEAT, beat - last_beat);
            fire(
                output_triggers,
                SHOW_TEMPO_OUT_ON_BAR,
                beat / beats_per_bar - last_beat / beats_per_bar,
            );
        }
        self.last_beat = Some(beat);

        outputs.insert(SHOW_TEMPO_OUT_BPM, FlowValue::Number(tempo.bpm as f32));
        outputs.insert(
            SHOW_TEMPO_OUT_BEAT,
            FlowValue::Int(tempo.beat_in_bar() as i32 + 1),
        );
        outputs.insert(
            SHOW_TEMPO_OUT_BAR,
            FlowValue::Int(i32::try_from(tempo.bar() + 1).unwrap_or(i32::MAX)),
        );
        outputs.insert(
            SHOW_TEMPO_OUT_PHASE,
            FlowValue::Number(tempo.beat_phase() as f32),
        );
        Ok(())
    }

    fn is_pure(&self) -> bool {
        false
    }

    fn reset(&mut self, _ctx: &FlowNodeContext) {
        self.last_beat = None;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nightfall_tempo::prelude::TempoSnapshot;

    use super::*;
    use crate::nodes::{FlowPortValues, FlowTriggerValues};

    /// Builds a context carrying a 4/4 tempo at the given beat position.
    fn context_at(beat_position: f64) -> FlowNodeContext {
        FlowNodeContext {
            position: Duration::ZERO,
            frame_delta: Duration::ZERO,
            tempo: Some(TempoSnapshot {
                bpm: 128.0,
                target_bpm: 128.0,
                beats_per_bar: 4,
                beat_position,
            }),
        }
    }

    /// Runs the node once and returns its outputs and fired triggers.
    fn run(node: &mut ShowTempoNode, ctx: &FlowNodeContext) -> (FlowPortValues, FlowTriggerValues) {
        let mut outputs = FlowPortValues::default();
        let mut triggers = FlowTriggerValues::default();
        node.execute(
            &FlowPortValues::default(),
            &mut outputs,
            &FlowTriggerValues::default(),
            &mut triggers,
            ctx,
        )
        .expect("show tempo node should execute");
        (outputs, triggers)
    }

    /// Verifies the node reports bar position and fires beat and bar triggers as they pass,
    /// without firing on its first evaluation.
    #[test]
    fn fires_on_beats_and_bars() {
        let mut node = ShowTempoNode::default();
        let (outputs, triggers) = run(&mut node, &context_at(2.5));
        assert!(triggers.is_empty());
        assert_eq!(outputs.get(&SHOW_TEMPO_OUT_BEAT), Some(&FlowValue::Int(3)));
        assert_eq!(outputs.get(&SHOW_TEMPO_OUT_BAR), Some(&FlowValue::Int(1)));
        assert_eq!(
            outputs.get(&SHOW_TEMPO_OUT_BPM),
            Some(&FlowValue::Number(128.0))
        );

        let (_, triggers) = run(&mut node, &context_at(3.9));
        assert_eq!(
            triggers.get(&SHOW_TEMPO_OUT_ON_BEAT).map(|t| t.count),
            Some(1)
        );
        assert!(!triggers.contains_key(&SHOW_TEMPO_OUT_ON_BAR));

        let (outputs, triggers) = run(&mut node, &context_at(4.1));
        assert_eq!(
            triggers.get(&SHOW_TEMPO_OUT_ON_BEAT).map(|t| t.count),
            Some(1)
        );
        assert_eq!(
            triggers.get(&SHOW_TEMPO_OUT_ON_BAR).map(|t| t.count),
            Some(1)
        );
        assert_eq!(outputs.get(&SHOW_TEMPO_OUT_BEAT), Some(&FlowValue::Int(1)));
        assert_eq!(outputs.get(&SHOW_TEMPO_OUT_BAR), Some(&FlowValue::Int(2)));
    }

    /// Verifies the node stays silent without a tempo engine and re-arms after reset.
    #[test]
    fn silent_without_tempo_and_rearms_on_reset() {
        let mut node = ShowTempoNode::default();
        let (outputs, triggers) = run(
            &mut node,
            &FlowNodeContext {
                position: Duration::ZERO,
                frame_delta: Duration::ZERO,
                tempo: None,
            },
        );
        assert!(outputs.is_empty() && triggers.is_empty());

        run(&mut node, &context_at(1.0));
        node.reset(&context_at(5.0));
        let (_, triggers) = run(&mut node, &context_at(5.0));
        assert!(triggers.is_empty());
    }
}
