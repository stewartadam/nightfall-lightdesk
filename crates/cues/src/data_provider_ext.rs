// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Extensions for cue-specific data provider lookups.

use dashmap::mapref::one::Ref;
use nightfall_engine::prelude::{DataProvider, DataStoreError};
use uuid::Uuid;

use crate::prelude::{Cue, Sequence};

/// Cue-specific helper lookups for DataProvider.
pub trait CueDataProviderExt {
    /// Look up a cue by sequence ID and cue ID.
    fn cue_by_sequence_id(
        &self,
        sequence_data_provider: &DataProvider<Sequence>,
        sequence_id: u32,
        cue_id: u32,
    ) -> Result<Ref<'_, Uuid, Cue>, DataStoreError<Cue>>;
}

impl CueDataProviderExt for DataProvider<Cue> {
    fn cue_by_sequence_id(
        &self,
        sequence_data_provider: &DataProvider<Sequence>,
        sequence_id: u32,
        cue_id: u32,
    ) -> Result<Ref<'_, Uuid, Cue>, DataStoreError<Cue>> {
        let sequence = sequence_data_provider
            .from_id(sequence_id)
            .map_err(|_| DataStoreError::no_such_id(cue_id))?;

        for step in &sequence.steps {
            let cue_uid: Uuid = (*step).into();
            if let Ok(cue_ref) = self.get(cue_uid) {
                if cue_ref.identifiers.id == cue_id {
                    return Ok(cue_ref);
                }
            }
        }

        Err(DataStoreError::no_such_id(cue_id))
    }
}
