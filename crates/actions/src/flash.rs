// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tracks active flashes so absolute actions return to their level when released.

use std::collections::HashMap;

use bevy_ecs::prelude::Resource;

use crate::invocation::ActionReference;

/// Normalized level a flash pushes its action to while held.
pub(crate) const FLASH_LEVEL: f32 = 1.0;

/// Largest difference at which two normalized levels count as the same position.
const LEVEL_TOLERANCE: f32 = 0.001;

/// One flashed action target and the controls currently holding it.
#[derive(Debug)]
struct ActiveFlash {
    /// Number of flash bindings currently pressed for this target.
    held: usize,
    /// Level to return to once the last flash is released, when the domain could read it.
    restore: Option<f32>,
}

/// Active flashes keyed by action and arguments, shared by every flash binding.
///
/// Several controls may flash the same target: the level is captured by the first press and
/// restored only after the last release.
#[derive(Debug, Default, Resource)]
pub(crate) struct FlashStates {
    active: HashMap<String, ActiveFlash>,
}

impl FlashStates {
    /// Records a press on `action`, capturing `current` as the restore level for the first one.
    pub(crate) fn press(&mut self, action: &ActionReference, current: Option<f32>) {
        self.active
            .entry(flash_key(action))
            .and_modify(|flash| flash.held += 1)
            .or_insert(ActiveFlash {
                held: 1,
                restore: current,
            });
    }

    /// Records a release on `action` and returns the level to restore, if any.
    ///
    /// Returns `None` while other flashes still hold the target, for releases without a
    /// matching press, and when the level was moved to something other than the flash level
    /// or the captured level during the flash, so the newer position wins.
    pub(crate) fn release(
        &mut self,
        action: &ActionReference,
        current: Option<f32>,
    ) -> Option<f32> {
        let key = flash_key(action);
        let flash = self.active.get_mut(&key)?;
        flash.held -= 1;
        if flash.held > 0 {
            return None;
        }
        let restore = self.active.remove(&key)?.restore?;
        let unchanged = current.is_none_or(|current| {
            (current - FLASH_LEVEL).abs() <= LEVEL_TOLERANCE
                || (current - restore).abs() <= LEVEL_TOLERANCE
        });
        unchanged.then_some(restore)
    }
}

/// Identifies one flashed target by action ID and arguments.
fn flash_key(action: &ActionReference) -> String {
    format!("{}:{}", action.id.as_str(), action.arguments)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Builds a flash target reference.
    fn target() -> ActionReference {
        ActionReference::new("test.level", json!({ "master": 1 }))
    }

    /// Verifies one flash restores the level captured on press.
    #[test]
    fn release_restores_the_captured_level() {
        let mut flashes = FlashStates::default();
        flashes.press(&target(), Some(0.4));

        assert_eq!(flashes.release(&target(), Some(FLASH_LEVEL)), Some(0.4));
        assert_eq!(flashes.release(&target(), Some(FLASH_LEVEL)), None);
    }

    /// Verifies stacked flashes restore only after the last release.
    #[test]
    fn stacked_flashes_restore_after_the_last_release() {
        let mut flashes = FlashStates::default();
        flashes.press(&target(), Some(0.4));
        flashes.press(&target(), Some(FLASH_LEVEL));

        assert_eq!(flashes.release(&target(), Some(FLASH_LEVEL)), None);
        assert_eq!(flashes.release(&target(), Some(FLASH_LEVEL)), Some(0.4));
    }

    /// Verifies a level moved during the flash wins over the captured one.
    #[test]
    fn a_level_moved_during_the_flash_wins() {
        let mut flashes = FlashStates::default();
        flashes.press(&target(), Some(0.4));

        assert_eq!(flashes.release(&target(), Some(0.7)), None);
    }

    /// Verifies a release in the same frame as the press, before the flash applied, restores.
    #[test]
    fn a_release_before_the_flash_applied_still_restores() {
        let mut flashes = FlashStates::default();
        flashes.press(&target(), Some(0.4));

        assert_eq!(flashes.release(&target(), Some(0.4)), Some(0.4));
    }
}
