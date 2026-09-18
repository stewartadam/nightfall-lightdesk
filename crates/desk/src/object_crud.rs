// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Generic CRUD handler for DataProvider-based objects
//!
//! This module provides a generic implementation for handling CRUD operations
//! on objects stored in DataProvider (Blueprint, Group).

use nightfall::data::HasIdentifiers;
use nightfall_engine::prelude::*;

/// Trait for objects that support CRUD operations
///
/// This trait provides type-safe access to CRUD command variants
/// and metadata about the object type for logging and error messages.
pub trait ObjectCrud: HasIdentifiers + Clone + Default {
    /// The command type used for CRUD operations on this object
    type Command: EnginePayload;

    /// Returns a human-readable name for this object type (e.g., "blueprint", "group", "clip")
    fn type_name() -> &'static str;

    /// Extracts the Store variant from a command, if present
    fn extract_store(command: &Self::Command) -> Option<Self>;

    /// Extracts the Rename variant from a command, if present
    fn extract_rename(command: &Self::Command) -> Option<(u32, u32)>;

    /// Extracts the Delete variant from a command, if present
    fn extract_delete(command: &Self::Command) -> Option<u32>;

    /// Sets the ID on this object (used during rename operations)
    fn set_id(&mut self, new_id: u32);
}

/// Applies one recognized CRUD command and returns its structured domain result.
///
/// `None` means the payload is not a CRUD variant for the object type. A
/// recognized command returns `Some`, including failures that made no mutation.
pub fn apply_object_crud_command<T>(
    command: &T::Command,
    provider: &mut DataProvider<T>,
) -> Option<Result<(), CommandError>>
where
    T: ObjectCrud,
{
    // Handle Store
    if let Some(object) = T::extract_store(command) {
        tracing::debug!(
            "Storing {} with ID: {}",
            T::type_name(),
            object.identifiers().id
        );
        return Some(provider.add(object).map_err(|error| {
            tracing::warn!("Failed to store {}: {}", T::type_name(), error);
            CommandError::new(
                format!("{}.store_failed", T::type_name()),
                format!("Failed to store {}: {}", T::type_name(), error),
            )
        }));
    }

    // Handle Rename
    if let Some((id, new_id)) = T::extract_rename(command) {
        tracing::debug!("Renaming {} {} -> {}", T::type_name(), id, new_id);

        // Check if new_id already exists
        if provider.from_id(new_id).is_ok() {
            tracing::warn!(
                "Failed to rename {} {} -> {}: already exists",
                T::type_name(),
                id,
                new_id
            );
            return Some(Err(CommandError::new(
                format!("{}.destination_exists", T::type_name()),
                format!(
                    "Failed to rename {} {} to {}: already exists",
                    T::type_name(),
                    id,
                    new_id
                ),
            )));
        }

        // Look up the object by ID
        let maybe_object = provider.from_id(id).map(|obj| obj.clone());
        if let Ok(mut object) = maybe_object {
            object.set_id(new_id);
            return Some(provider.add(object).map_err(|error| {
                CommandError::new(
                    format!("{}.rename_failed", T::type_name()),
                    format!(
                        "Failed to rename {} {} to {}: {}",
                        T::type_name(),
                        id,
                        new_id,
                        error
                    ),
                )
            }));
        } else {
            tracing::warn!(
                "Failed to rename {} {} -> {}: not found",
                T::type_name(),
                id,
                new_id
            );
            return Some(Err(CommandError::new(
                format!("{}.not_found", T::type_name()),
                format!(
                    "Failed to rename {} {} to {}: not found",
                    T::type_name(),
                    id,
                    new_id
                ),
            )));
        }
    }

    // Handle Delete
    if let Some(id) = T::extract_delete(command) {
        tracing::debug!("Deleting {} with ID: {}", T::type_name(), id);

        // Look up the object by ID to get its UID
        let maybe_uid = provider.from_id(id).map(|obj| obj.identifiers().uid);
        if let Ok(uid) = maybe_uid {
            return Some(provider.remove(&uid).map(|_| ()).map_err(|error| {
                tracing::warn!("Failed to delete {} {}: {}", T::type_name(), id, error);
                CommandError::new(
                    format!("{}.delete_failed", T::type_name()),
                    format!("Failed to delete {} {}: {}", T::type_name(), id, error),
                )
            }));
        } else {
            tracing::warn!("Failed to delete {} {}: not found", T::type_name(), id);
            return Some(Err(CommandError::new(
                format!("{}.not_found", T::type_name()),
                format!("Failed to delete {} {}: not found", T::type_name(), id),
            )));
        }
    }

    // Not a CRUD command
    None
}
