// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime resources describing the active showfile and its clean snapshot baseline.

use super::*;

/// Name of the showfile currently loaded in the runtime.
#[derive(Resource, Debug, Clone, Default, PartialEq, Eq)]
pub struct CurrentShowfile {
    pub(super) name: Option<String>,
}

impl CurrentShowfile {
    /// Return the current named showfile, or `None` for the default showfile.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Set the current showfile name, normalizing `default` to the default showfile.
    pub fn set_name(&mut self, showfile_name: Option<&str>) -> Result<(), String> {
        self.name = current_showfile_name(showfile_name)?;
        Ok(())
    }
}

/// Hash of the clean showfile snapshot for dirty detection.
#[derive(Resource, Debug, Clone, Default, PartialEq, Eq)]
pub struct ShowfileCleanSnapshotHash {
    pub(super) hash: Option<u64>,
    pub(super) metadata: ShowfileMetadata,
}
