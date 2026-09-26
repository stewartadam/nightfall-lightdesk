// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bounded transport edge history for controller input interpretation.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

const MAX_CONTROLS: usize = 4096;

/// Remembers button state without allowing arbitrary controller addresses to grow memory forever.
///
/// At capacity, a newly observed control replaces the oldest admitted control. Evicted controls
/// have unknown prior state when they return. Existing controls do not allocate additional entries.
pub struct ControllerEdgeHistory<K> {
    states: HashMap<K, bool>,
    order: VecDeque<K>,
}

impl<K> Default for ControllerEdgeHistory<K> {
    /// Starts with no observed controls and allocates storage only as input arrives.
    fn default() -> Self {
        Self {
            states: HashMap::new(),
            order: VecDeque::new(),
        }
    }
}

impl<K: Eq + Hash + Clone> ControllerEdgeHistory<K> {
    /// Stores the current state and returns the previous state, if this control is retained.
    pub fn observe(&mut self, control: K, active: bool) -> Option<bool> {
        if let Some(previous) = self.states.get_mut(&control) {
            return Some(std::mem::replace(previous, active));
        }
        if self.states.len() == MAX_CONTROLS {
            if let Some(oldest) = self.order.pop_front() {
                self.states.remove(&oldest);
            }
        }
        self.order.push_back(control.clone());
        self.states.insert(control, active);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Repeated packets retain both edges while new sources evict only one oldest entry.
    #[test]
    fn bounds_history_without_clearing_other_controls() {
        let mut history = ControllerEdgeHistory::default();
        for control in 0..MAX_CONTROLS {
            assert_eq!(history.observe(control, true), None);
        }
        assert_eq!(history.observe(1, false), Some(true));
        assert_eq!(history.observe(1, false), Some(false));
        assert_eq!(history.observe(MAX_CONTROLS, true), None);
        assert_eq!(history.states.len(), MAX_CONTROLS);
        assert_eq!(history.order.len(), MAX_CONTROLS);
        assert!(!history.states.contains_key(&0));
        assert_eq!(history.observe(1, true), Some(false));
        assert_eq!(history.observe(MAX_CONTROLS, false), Some(true));
    }
}
