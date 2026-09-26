// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_timeline::prelude::ParameterType;
use uuid::Uuid;

/// Keeps clip targets textual across CBOR publications and JSON edit commands.
#[test]
fn rate_master_target_round_trips_through_cbor_and_json() {
    let uid = Uuid::parse_str("50efca4267444a0bbed89a0f69930b9e").unwrap();
    let parameter = ParameterType::RateMaster(uid);
    let bytes = minicbor_serde::to_vec(&parameter).unwrap();
    let published: serde_json::Value = minicbor_serde::from_slice(&bytes).unwrap();
    assert_eq!(published["data"], uid.simple().to_string());
    let command_json = serde_json::to_string(&published).unwrap();
    let restored: ParameterType = serde_json::from_str(&command_json).unwrap();
    assert!(matches!(restored, ParameterType::RateMaster(target) if target == uid));
}
