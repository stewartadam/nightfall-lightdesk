// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Seeds reusable Color and Position Blueprints for sample-show exploration.
pub(super) fn add_blueprints(world: &mut World) {
    let mut system_state: SystemState<ResMut<DataProvider<Blueprint>>> = SystemState::new(world);
    let mut blueprint_data_provider = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    let blueprints = [
        Blueprint {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "Warm Amber".to_owned(),
            },
            values: HashMap::from([
                (
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                ),
                (
                    Attribute::Green,
                    ValueSource::Inline(ParameterValue::AbsolutePercent {
                        value: 0.627.into(),
                    }),
                ),
                (
                    Attribute::Blue,
                    ValueSource::Inline(ParameterValue::AbsolutePercent {
                        value: 0.094.into(),
                    }),
                ),
            ]),
            ..Default::default()
        },
        Blueprint {
            identifiers: Identifiers {
                id: 2,
                uid: Uuid::new_v4(),
                label: "Pan 25 Tilt 75".to_owned(),
            },
            values: HashMap::from([
                (
                    Attribute::Pan,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.25.into() }),
                ),
                (
                    Attribute::Tilt,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.75.into() }),
                ),
            ]),
            ..Default::default()
        },
    ];

    for blueprint in blueprints {
        blueprint_data_provider
            .add(blueprint)
            .expect("sample data should not have duplicate Blueprint IDs");
    }

    system_state.apply(world);
}
