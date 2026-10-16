// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Pure fixture-selection contracts and resolution algorithms.

mod contracts;
mod linear;
mod references;
mod spatial;
mod structure;
mod validation;

#[cfg(test)]
mod tests;

pub use contracts::{
    SelectionDataSource, SelectionFixture, SelectionGroup, SpatialSelectionResolution,
};
pub use linear::SelectionResolver;
pub use references::{
    HeldReference, LookupKey, OwnerKey, OwnerReferences, ReferenceBook, ReferenceDomain,
    ReferenceEntry, ReferenceIssue, ReferenceIssueReason, ReferenceLookup, ReferenceOwner,
    ReferenceSource, ReferenceStatus, ReferenceSummary, ReferenceTarget, audit_owner,
    prune_missing_fixture_refs,
};
pub use spatial::SpatialSelectionResolver;
pub use validation::{
    SelectionValidatedEntity, filter_existing_selection, selection_validation_warnings,
};

/// Common selection contracts used by storage and domain integrations.
pub mod prelude {
    pub use crate::{
        SelectionDataSource, SelectionFixture, SelectionValidatedEntity,
        SpatialSelectionResolution, filter_existing_selection, selection_validation_warnings,
    };
}
