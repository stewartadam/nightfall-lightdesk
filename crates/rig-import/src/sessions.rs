// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Rigs that have been read and wait to be previewed, imported or discarded.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use bevy_ecs::prelude::*;
use uuid::Uuid;

use crate::rig::RigFile;

/// Most rigs kept at once; reading another drops the oldest.
pub const MAX_SESSIONS: usize = 4;

/// Rigs read by the upload route, shared between the HTTP server and the engine.
///
/// Each rig is kept under a session ID until the client discards it, so a large file is
/// read once however often the preview changes. Only the last [`MAX_SESSIONS`] are kept,
/// so a client that never discards cannot fill the disk with extracted fixture types.
#[derive(Resource, Clone, Default)]
pub struct RigImportSessions(Arc<Mutex<Sessions>>);

/// Rigs by session, with the order they arrived in.
#[derive(Default)]
struct Sessions {
    /// Session IDs, oldest first.
    order: VecDeque<Uuid>,
    /// Rigs by session ID.
    rigs: HashMap<Uuid, Arc<RigFile>>,
}

impl RigImportSessions {
    /// Keeps a rig under a new session ID and returns the ID.
    pub fn insert(&self, rig: RigFile) -> Uuid {
        let session = Uuid::new_v4();
        let mut sessions = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        sessions.order.push_back(session);
        sessions.rigs.insert(session, Arc::new(rig));
        while sessions.order.len() > MAX_SESSIONS {
            if let Some(oldest) = sessions.order.pop_front() {
                sessions.rigs.remove(&oldest);
            }
        }
        session
    }

    /// Returns the rig kept under `session`.
    pub fn get(&self, session: Uuid) -> Option<Arc<RigFile>> {
        let sessions = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        sessions.rigs.get(&session).cloned()
    }

    /// Drops the rig kept under `session`, returning whether there was one.
    pub fn remove(&self, session: Uuid) -> bool {
        let mut sessions = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        sessions.order.retain(|candidate| *candidate != session);
        sessions.rigs.remove(&session).is_some()
    }
}
