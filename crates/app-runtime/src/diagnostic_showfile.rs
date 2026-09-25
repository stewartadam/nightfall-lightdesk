// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! On-demand snapshots taken from the active engine world, independently of WebSocket connectivity.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, mpsc};

/// Showfile state and the asset root belonging to the same engine snapshot.
pub struct DiagnosticShowfile {
    pub snapshot: nightfall_showfile::ShowfileSnapshot,
    pub asset_root: PathBuf,
    pub source: &'static str,
}

type Reply = tokio::sync::oneshot::Sender<Result<DiagnosticShowfile, String>>;
static REQUESTS: OnceLock<Mutex<Option<mpsc::SyncSender<Reply>>>> = OnceLock::new();

/// Registers a bounded request channel for the active session, surviving its world swaps.
pub(crate) fn register_requests() -> mpsc::Receiver<Reply> {
    let (sender, receiver) = mpsc::sync_channel(1);
    *REQUESTS.get_or_init(Mutex::default).lock().unwrap() = Some(sender);
    receiver
}

/// Captures requested state on the engine thread without changing or saving the user's showfile.
pub(crate) fn respond_to_requests(
    receiver: &mpsc::Receiver<Reply>,
    world: &mut bevy::prelude::World,
) {
    if let Ok(reply) = receiver.try_recv() {
        if reply.is_closed() {
            return;
        }
        let result = nightfall_showfile::snapshot_from_world(world).and_then(|snapshot| {
            Ok(DiagnosticShowfile {
                snapshot,
                asset_root: nightfall::active_show_data_dir().ok_or("No active showfile")?,
                source: "current engine state",
            })
        });
        let _ = reply.send(result);
    }
}

/// Reads the latest stored snapshot when startup has not produced an active engine world.
pub(crate) fn read_stored_showfile(asset_root: PathBuf) -> Result<DiagnosticShowfile, String> {
    let snapshot = crate::systems::showfile_events::read_showfile_snapshot_from_path(&asset_root)
        .map_err(|error| format!("Could not read the stored showfile: {error}"))?;
    Ok(DiagnosticShowfile {
        snapshot,
        asset_root,
        source: "latest stored snapshot (engine unavailable)",
    })
}

/// Requests live state, falling back to disk if the engine cannot respond during startup or a stall.
pub async fn capture_showfile() -> Result<DiagnosticShowfile, String> {
    let sender = REQUESTS.get().and_then(|lock| lock.lock().ok()?.clone());
    if let Some(sender) = sender {
        let (reply, response) = tokio::sync::oneshot::channel();
        if sender.try_send(reply).is_ok() {
            if let Ok(Ok(Ok(snapshot))) =
                tokio::time::timeout(std::time::Duration::from_secs(3), response).await
            {
                return Ok(snapshot);
            }
        }
    }
    let root = nightfall::active_show_data_dir().ok_or("No active showfile")?;
    tokio::task::spawn_blocking(move || read_stored_showfile(root))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Startup fallback reads the latest stored draft without changing it and labels its provenance.
    #[test]
    fn stored_snapshot_retains_contents_and_reports_missing_showfiles() {
        let directory = tempfile::tempdir().unwrap();
        assert!(read_stored_showfile(directory.path().to_owned()).is_err());
        let path = directory.path().join("showfile.json");
        let mut stored = nightfall_showfile::ShowfileSnapshot {
            metadata: nightfall_showfile::current_showfile_metadata(),
            ..Default::default()
        };
        stored.metadata.nightfall_version = "test".to_string();
        let bytes = nightfall_showfile::serialize_showfile_snapshot_json(&stored).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let snapshot = read_stored_showfile(directory.path().to_owned()).unwrap();
        assert_eq!(snapshot.snapshot.metadata.nightfall_version, "test");
        assert!(snapshot.source.contains("engine unavailable"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), bytes);
    }

    /// Requests capture unsaved state from whichever world is active without modifying desk settings.
    #[test]
    fn queued_requests_follow_the_active_world_after_a_swap() {
        use nightfall_desk::prelude::DeskSettings;
        let (sender, receiver) = mpsc::sync_channel(1);
        for device in ["unsaved first world", "replacement world"] {
            let mut world = bevy::prelude::World::new();
            nightfall_showfile::initialize_showfile_resources(&mut world);
            world.resource_mut::<DeskSettings>().audio_device = Some(device.to_string());
            let before = serde_json::to_value(world.resource::<DeskSettings>()).unwrap();
            let (reply, mut response) = tokio::sync::oneshot::channel();
            sender.try_send(reply).unwrap();
            respond_to_requests(&receiver, &mut world);
            let snapshot = response.try_recv().unwrap().unwrap();
            assert_eq!(
                snapshot.snapshot.settings.audio_device.as_deref(),
                Some(device)
            );
            assert_eq!(snapshot.source, "current engine state");
            assert_eq!(
                serde_json::to_value(world.resource::<DeskSettings>()).unwrap(),
                before
            );
        }
    }
}
