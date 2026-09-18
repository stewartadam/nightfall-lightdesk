// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
mod service;

use crate::service::{AudioOutputClient, AudioOutputDeviceInfo, AudioWorkerSinkState};

/// Unique identifier for an audio sink
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AudioSinkId(u32);

/// Information about an active audio sink
#[derive(Debug)]
struct AudioSinkInfo {
    is_playing: bool,
    current_file: Option<String>,
    volume: f32,
    position: Duration,
    playback_started_at: Option<Instant>,
}

impl Default for AudioSinkInfo {
    fn default() -> Self {
        Self {
            is_playing: false,
            current_file: None,
            volume: 1.0,
            position: Duration::ZERO,
            playback_started_at: None,
        }
    }
}

impl AudioSinkInfo {
    fn current_position(&self) -> Duration {
        if self.is_playing
            && let Some(playback_started_at) = self.playback_started_at
        {
            return self.position.saturating_add(playback_started_at.elapsed());
        }

        self.position
    }

    fn snapshot(&self, sink_id: AudioSinkId) -> AudioWorkerSinkState {
        AudioWorkerSinkState {
            id: sink_id.0,
            current_file: self.current_file.clone(),
            volume: self.volume,
            position: self.current_position(),
            is_playing: self.is_playing,
        }
    }
}

/// Manages audio playback through multiple audio sinks.
///
/// Commands are forwarded to the process-lifetime audio worker via `AudioOutputClient`.
#[derive(Resource, Debug)]
pub struct AudioController {
    client: AudioOutputClient,
    sinks: HashMap<AudioSinkId, AudioSinkInfo>,
}

impl AudioController {
    /// Create a new AudioController with the given process-lifetime audio client.
    pub fn new(client: AudioOutputClient) -> Self {
        Self {
            client,
            sinks: HashMap::new(),
        }
    }

    /// Create a new audio sink and return its ID.
    pub fn create_sink(&mut self) -> Option<AudioSinkId> {
        let sink_id = self.client.create_sink().map(AudioSinkId)?;
        self.sinks.insert(sink_id, AudioSinkInfo::default());
        Some(sink_id)
    }

    /// Destroy an audio sink.
    pub fn destroy_sink(&mut self, id: AudioSinkId) -> bool {
        if self.sinks.remove(&id).is_some() {
            return self.client.destroy_sink(id.0);
        }
        false
    }

    /// List all active sink IDs.
    pub fn list_sinks(&self) -> Vec<AudioSinkId> {
        self.sinks.keys().copied().collect()
    }

    /// Play the audio in the specified sink.
    pub fn play(&mut self, id: AudioSinkId) -> bool {
        if !self.sinks.contains_key(&id) {
            tracing::warn!(?id, "Attempted to play non-existent sink");
            return false;
        }

        if self.client.play(id.0)
            && let Some(sink) = self.sinks.get_mut(&id)
        {
            if !sink.is_playing {
                sink.playback_started_at = Some(Instant::now());
            }
            sink.is_playing = true;
            return true;
        }
        false
    }

    /// Pause the audio in the specified sink.
    pub fn pause(&mut self, id: AudioSinkId) -> bool {
        if !self.sinks.contains_key(&id) {
            tracing::warn!(?id, "Attempted to pause non-existent sink");
            return false;
        }

        if self.client.pause(id.0)
            && let Some(sink) = self.sinks.get_mut(&id)
        {
            sink.position = sink.current_position();
            sink.playback_started_at = None;
            sink.is_playing = false;
            return true;
        }
        false
    }

    /// Stop the audio in the specified sink.
    pub fn stop(&mut self, id: AudioSinkId) -> bool {
        if !self.sinks.contains_key(&id) {
            tracing::warn!(?id, "Attempted to stop non-existent sink");
            return false;
        }

        if self.client.stop(id.0)
            && let Some(sink) = self.sinks.get_mut(&id)
        {
            sink.position = Duration::ZERO;
            sink.playback_started_at = None;
            sink.is_playing = false;
            return true;
        }
        false
    }

    /// Set the volume for the specified sink (0.0 to 1.0).
    pub fn set_volume(&mut self, id: AudioSinkId, volume: f32) -> bool {
        if !self.sinks.contains_key(&id) {
            tracing::warn!(?id, "Attempted to set volume on non-existent sink");
            return false;
        }

        if self.client.set_volume(id.0, volume)
            && let Some(sink) = self.sinks.get_mut(&id)
        {
            sink.volume = volume;
            return true;
        }
        false
    }

    /// Load a file into the specified sink.
    pub fn load_file(&mut self, id: AudioSinkId, path: &str) -> bool {
        if !self.sinks.contains_key(&id) {
            tracing::warn!(?id, "Attempted to load file into non-existent sink");
            return false;
        }

        if self.client.load_file(id.0, path.to_string())
            && let Some(sink) = self.sinks.get_mut(&id)
        {
            sink.current_file = Some(path.to_string());
            sink.position = Duration::ZERO;
            sink.playback_started_at = None;
            sink.is_playing = false;
            return true;
        }
        false
    }

    /// Seek to a position in the specified sink.
    pub fn seek(&mut self, id: AudioSinkId, position: Duration) -> bool {
        if !self.sinks.contains_key(&id) {
            tracing::warn!(?id, "Attempted to seek in non-existent sink");
            return false;
        }

        if self.client.seek(id.0, position) {
            if let Some(sink) = self.sinks.get_mut(&id) {
                sink.position = position;
                if sink.is_playing {
                    sink.playback_started_at = Some(Instant::now());
                }
            }
            return true;
        }

        false
    }

    /// Check if the specified sink is currently playing.
    pub fn is_playing(&self, id: AudioSinkId) -> bool {
        self.sinks.get(&id).map(|s| s.is_playing).unwrap_or(false)
    }

    /// Get the current file for the specified sink, if any.
    pub fn current_file(&self, id: AudioSinkId) -> Option<&str> {
        self.sinks.get(&id).and_then(|s| s.current_file.as_deref())
    }

    /// Get the current volume for the specified sink.
    pub fn volume(&self, id: AudioSinkId) -> Option<f32> {
        self.sinks.get(&id).map(|s| s.volume)
    }

    /// Rebuild the current sinks on a different output device.
    pub fn reconfigure_output_device(&mut self, device_id: Option<String>) -> bool {
        let sinks = self
            .sinks
            .iter()
            .map(|(sink_id, sink)| sink.snapshot(*sink_id))
            .collect();

        self.client.reconfigure_output(device_id, sinks)
    }
}

impl Drop for AudioController {
    fn drop(&mut self) {
        let sink_ids: Vec<_> = self.sinks.keys().copied().collect();
        for sink_id in sink_ids {
            let _ = self.client.destroy_sink(sink_id.0);
        }
    }
}

pub fn available_output_devices() -> Vec<AudioOutputDeviceInfo> {
    service::available_output_devices()
}

pub fn default_output_device() -> Option<AudioOutputDeviceInfo> {
    service::default_output_device()
}

/// Plugin for audio management.
pub struct AudioPlugin;

impl Plugin for AudioPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering AudioPlugin");

        let audio_service = service::process_audio_output_service();
        let _ = audio_service.ensure_started();
        let audio_client = audio_service.client();

        app.insert_resource(AudioController::new(audio_client));
    }
}

pub mod prelude {
    pub use crate::{AudioController, AudioPlugin, AudioSinkId};
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::AudioWorkerCommand;

    fn next_command(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<AudioWorkerCommand>,
    ) -> AudioWorkerCommand {
        rx.try_recv()
            .expect("expected audio worker command to be queued")
    }

    #[test]
    fn reconfigure_output_device_snapshots_current_sink_state() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let client = AudioOutputClient::default();
        client.set_sender(Some(tx));

        let mut controller = AudioController::new(client);
        let sink_id = controller
            .create_sink()
            .expect("expected sink to be created");
        assert!(matches!(
            next_command(&mut rx),
            AudioWorkerCommand::CreateSink(id) if id == sink_id.0
        ));

        assert!(controller.load_file(sink_id, "/tmp/test-audio.wav"));
        assert!(matches!(
            next_command(&mut rx),
            AudioWorkerCommand::LoadFile(id, path)
                if id == sink_id.0 && path == "/tmp/test-audio.wav"
        ));

        assert!(controller.set_volume(sink_id, 0.25));
        assert!(matches!(
            next_command(&mut rx),
            AudioWorkerCommand::SetVolume(id, volume)
                if id == sink_id.0 && (volume - 0.25).abs() < f32::EPSILON
        ));

        assert!(controller.seek(sink_id, Duration::from_secs(3)));
        assert!(matches!(
            next_command(&mut rx),
            AudioWorkerCommand::Seek(id, position)
                if id == sink_id.0 && position == Duration::from_secs(3)
        ));

        assert!(controller.reconfigure_output_device(Some("cpal:device-1".to_string())));
        match next_command(&mut rx) {
            AudioWorkerCommand::ReconfigureOutput { device_id, sinks } => {
                assert_eq!(device_id.as_deref(), Some("cpal:device-1"));
                assert_eq!(sinks.len(), 1);
                let sink = &sinks[0];
                assert_eq!(sink.id, sink_id.0);
                assert_eq!(sink.current_file.as_deref(), Some("/tmp/test-audio.wav"));
                assert!((sink.volume - 0.25).abs() < f32::EPSILON);
                assert_eq!(sink.position, Duration::from_secs(3));
                assert!(!sink.is_playing);
            }
            command => panic!("expected reconfigure output command, got {command:?}"),
        }
    }

    #[test]
    fn reconfigure_output_device_preserves_playing_state() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let client = AudioOutputClient::default();
        client.set_sender(Some(tx));

        let mut controller = AudioController::new(client);
        let sink_id = controller
            .create_sink()
            .expect("expected sink to be created");
        let _ = next_command(&mut rx);

        assert!(controller.seek(sink_id, Duration::from_secs(1)));
        let _ = next_command(&mut rx);
        assert!(controller.play(sink_id));
        let _ = next_command(&mut rx);

        assert!(controller.reconfigure_output_device(None));
        match next_command(&mut rx) {
            AudioWorkerCommand::ReconfigureOutput { device_id, sinks } => {
                assert_eq!(device_id, None);
                assert_eq!(sinks.len(), 1);
                assert!(sinks[0].is_playing);
                assert!(sinks[0].position >= Duration::from_secs(1));
            }
            command => panic!("expected reconfigure output command, got {command:?}"),
        }
    }
}
