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

    let group_defs = vec![
        (
            "Pixel Tapes Left",
            vec![
                310, 311, 312, 313, 330, 331, 332, 333, 350, 351, 352, 353, 370, 371, 372, 373,
            ],
        ),
        (
            "Pixel Tapes Right",
            vec![
                320, 321, 322, 323, 340, 341, 342, 343, 360, 361, 362, 363, 380, 381, 382, 383,
            ],
        ),
        ("bstrip 1 left", vec![310, 311, 312, 313]),
        ("bstrip 1 right", vec![320, 321, 322, 323]),
        ("bstrip 2 left", vec![330, 331, 332, 333]),
        ("bstrip 2 right", vec![340, 341, 342, 343]),
        ("bstrip 3 left", vec![350, 351, 352, 353]),
        ("bstrip 3 right", vec![360, 361, 362, 363]),
        ("bstrip 4 left", vec![370, 371, 372, 373]),
        ("bstrip 4 right", vec![380, 381, 382, 383]),
        ("Strobe Bars Left", vec![1004, 1005, 1006]),
        ("Strobe Bars Right", vec![1007, 1008, 1009]),
        ("Spots Front", vec![501, 502, 503, 504, 505, 506]),
        ("Rotating Wash", vec![1010, 1011, 1012, 1013, 1014, 1015]),
        ("Matrix Strobes", vec![601, 602, 603, 604, 605, 606]),
    ];

    for (idx, (label, fixture_ids)) in group_defs.into_iter().enumerate() {
        // build a flat list of all element‐refs in this group:
        let elements: Vec<FixtureRef> = fixture_ids
            .into_iter()
            .map(|id| {
                fixture_data_provider
                    .inner
                    .from_id(id)
                    .expect("sample group fixture must exist")
            })
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
}
