// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Console-side application of fixture profile relations.
//!
//! Virtual channels exist only in the console, so every relation that
//! involves one is the console's to apply: a virtual master's level never
//! reaches the fixture, and a virtual follower (such as a pixel dimmer that
//! follows the body dimmer) is computed here before its own followers read
//! it. Relations between two real channels are evaluated by the fixture
//! itself and are left to the visualizer to simulate.
//!
//! Both sides evaluate relations with `nightfall_fixture_model`'s
//! [`FixtureEvaluator`]; this system only moves parameter values in and out.

use bevy_ecs::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::*;

/// A fixture with relations the console applies, and the parameter entity
/// of each of its model's parameters.
struct ConsoleFixture {
    /// Evaluator of the fixture's model.
    evaluator: FixtureEvaluator,
    /// Parameter entity of each model parameter, when spawned.
    entities: Vec<Option<Entity>>,
    /// Current values read each frame, reused between frames.
    inputs: Vec<Option<f32>>,
}

/// Fixtures with console-applied relations, rebuilt when fixture data changes.
#[derive(Default)]
pub struct ConsoleRelationFixtures {
    /// Fixtures with at least one relation the console applies.
    fixtures: Vec<ConsoleFixture>,
}

impl ConsoleRelationFixtures {
    /// Rebuilds the model and entity table of every fixture with
    /// console-applied relations.
    fn rebuild(&mut self, data_provider: &FixtureDataProviderExt) {
        self.fixtures.clear();
        for fixture in data_provider.inner.iter() {
            let model = FixtureModel::new(
                fixture
                    .elements
                    .iter()
                    .map(|element| element.parameters.iter().cloned()),
                true,
            );
            if !model.has_relations(RelationScope::Console) {
                continue;
            }
            let fixture_uid = fixture.identifiers.uid;
            let entities = fixture
                .elements
                .iter()
                .enumerate()
                .flat_map(|(index, element)| {
                    let element_ref = FixtureRef {
                        fixture_uid,
                        index: Some(index as u32 + 1),
                    };
                    element.parameters.iter().map(move |parameter| {
                        data_provider
                            .try_parameter_for_element_attribute(&element_ref, &parameter.attribute)
                            .map(|instance| instance.entity())
                    })
                })
                .collect::<Vec<_>>();
            self.fixtures.push(ConsoleFixture {
                inputs: vec![None; entities.len()],
                evaluator: FixtureEvaluator::new(model),
                entities,
            });
        }
    }
}

/// Applies the relations the console is responsible for to their followers'
/// current values (see [`RelationScope::Console`]).
pub fn apply_virtual_relations(
    mut param_query: Query<&mut Parameter>,
    data_provider: Res<FixtureDataProviderExt>,
    mut cache: Local<ConsoleRelationFixtures>,
) {
    if data_provider.is_changed() {
        cache.rebuild(&data_provider);
    }

    for fixture in &mut cache.fixtures {
        for (input, entity) in fixture.inputs.iter_mut().zip(&fixture.entities) {
            *input = entity
                .and_then(|entity| param_query.get(entity).ok())
                .map(|parameter| parameter.values.current_value);
        }
        let resolved = fixture
            .evaluator
            .resolve(RelationScope::Console, &fixture.inputs);
        for ((entity, input), value) in fixture.entities.iter().zip(&fixture.inputs).zip(resolved) {
            if let (Some(entity), Some(value)) = (entity, value)
                && input != &Some(*value)
                && let Ok(mut parameter) = param_query.get_mut(*entity)
            {
                parameter.values.current_value = *value;
            }
        }
    }
}
