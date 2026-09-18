// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Seed fixture groups after the fixture inventory is available.
pub(super) fn add_groups(world: &mut World) {
    let mut system_state: SystemState<(
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Group>>,
    )> = SystemState::new(world);
    let (fixture_data_provider, mut group_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    // inside add_groups()

    // define each region by its fixture IDs
    let group_defs = vec![
        ("Tubes Left", vec![211, 212, 213, 214, 215, 216]),
        ("Tubes Right", vec![221, 222, 223, 224, 225, 226]),
        ("bstrip 1 left", vec![311, 312, 313, 314, 315]),
        ("bstrip 1 right", vec![321, 322, 323, 324, 325]),
        ("bstrip 2 left", vec![331, 332, 333, 334, 335]),
        ("bstrip 2 right", vec![341, 342, 343, 344, 345]),
        ("bstrip 3 left", vec![351, 352, 353, 354, 355]),
        ("bstrip 3 right", vec![361, 362, 363, 364, 365]),
        ("bstrip 4 left", vec![371, 372, 373, 374, 375]),
        ("bstrip 4 right", vec![381, 382, 383, 384, 385]),
        ("Overhead Left", vec![411, 412, 413, 414, 415, 416]),
        ("Overhead Right", vec![421, 422, 423, 424, 425, 426]),
        (
            "Spots Front",
            vec![501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511, 512],
        ),
        (
            "Spots Rear",
            vec![513, 514, 515, 516, 517, 518, 519, 520, 521, 522, 523, 524],
        ),
        ("Manual Strobes", vec![601, 602, 603, 604, 605, 606]),
    ];

    for (idx, (label, fixture_ids)) in group_defs.into_iter().enumerate() {
        // build a flat list of all element‐refs in this group:
        let elements: Vec<FixtureRef> = fixture_ids
            .into_iter()
            .filter_map(|id| fixture_data_provider.inner.from_id(id).ok())
            .flat_map(|fixture| {
                let uid = fixture.identifiers.uid;
                fixture
                    .elements
                    .iter()
                    .enumerate()
                    .map(|(i, _)| FixtureRef {
                        fixture_uid: uid,
                        index: Some(i as u32 + 1),
                    })
                    .collect::<Vec<_>>()
            })
            .collect();

        let _ = group_data_provider.add(Group {
            identifiers: Identifiers {
                id: idx as u32 + 1,
                label: label.to_string(),
                uid: Uuid::new_v4(),
            },
            selection: SelectionExpr::Resolved(elements).into(),
            description: Default::default(),
        });
    }

    system_state.apply(world);

    system_state.apply(world);
}
