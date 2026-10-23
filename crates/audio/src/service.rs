// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU32, Ordering},
};
use std::time::Duration;

use nightfall_engine::prelude::{
    DebugPanicTarget, is_process_shutdown_requested, maybe_trigger_debug_worker_panic,
};
use nightfall_service_host::prelude::{WorkerSlot, process_singleton};
use rodio::{DeviceTrait, cpal::traits::HostTrait};
use tokio::sync::mpsc::UnboundedSender;

const AUDIO_WORKER_IDLE_SLEEP: Duration = Duration::from_millis(10);
/// Drift between a sink's played position and the timecode that triggers a corrective seek.
const CLOCK_DRIFT_TOLERANCE: Duration = Duration::from_millis(150);

/// User-facing description of an audio output device exposed by the service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioOutputDeviceInfo {
    pub id: String,
    pub display_name: String,
}

fn audio_output_device_info(device: &rodio::Device) -> Option<AudioOutputDeviceInfo> {
    let display_name = device
        .description()
        .ok()
        .map(|description| description.name().to_string());

    let id = device
        .id()
        .map(|id| format!("cpal:{id}"))
        .ok()
        .or_else(|| {
            device.description().ok().map(|description| {
                format!(
                    "name:{}:{}",
                    description.driver().unwrap_or("unknown"),
                    description.name()
                )
            })
        })?;

    Some(AudioOutputDeviceInfo {
        display_name: display_name.unwrap_or_else(|| id.clone()),
        id,
    })
}

pub fn available_output_devices() -> Vec<AudioOutputDeviceInfo> {
    let Ok(devices) = rodio::cpal::default_host().output_devices() else {
        return Vec::new();
    };

    devices
        .filter_map(|device| audio_output_device_info(&device))
        .collect()
}

pub fn default_output_device() -> Option<AudioOutputDeviceInfo> {
    rodio::cpal::default_host()
        .default_output_device()
        .and_then(|device| audio_output_device_info(&device))
}

fn find_output_device(id: &str) -> Option<rodio::Device> {
    let Ok(mut devices) = rodio::cpal::default_host().output_devices() else {
        return None;
    };

    devices.find(|device| {
        audio_output_device_info(device)
            .as_ref()
            .is_some_and(|info| info.id == id)
    })
}

fn open_output_sink(device_id: Option<&str>) -> Result<rodio::MixerDeviceSink, String> {
    match device_id {
        Some(id) => {
            let Some(device) = find_output_device(id) else {
                return Err(format!("Audio output device '{id}' is unavailable"));
            };

            rodio::DeviceSinkBuilder::from_device(device)
                .and_then(|builder| builder.open_sink_or_fallback())
                .map_err(|error| format!("Failed to open audio output device '{id}': {error}"))
        }
        None => rodio::DeviceSinkBuilder::open_default_sink()
            .map_err(|error| format!("Failed to open default audio output device: {error}")),
    }
}

/// Cloneable client for process-lifetime audio output services.
#[derive(Debug, Clone, Default)]
pub struct AudioOutputClient {
    command_tx: Arc<Mutex<Option<UnboundedSender<AudioWorkerCommand>>>>,
    next_sink_id: Arc<AtomicU32>,
}

impl AudioOutputClient {
    /// Create a new sink on the process-lifetime audio worker.
    ///
    /// Returns `None` when the audio service is unavailable.
    pub fn create_sink(&self) -> Option<u32> {
        let sink_id = self.next_sink_id.fetch_add(1, Ordering::Relaxed);
        if self.send_command(AudioWorkerCommand::CreateSink(sink_id)) {
            return Some(sink_id);
        }
        None
    }

    /// Destroy an existing sink on the process-lifetime audio worker.
    pub fn destroy_sink(&self, sink_id: u32) -> bool {
        self.send_command(AudioWorkerCommand::DestroySink(sink_id))
    }

    /// Start playback for an existing sink.
    pub fn play(&self, sink_id: u32) -> bool {
        self.send_command(AudioWorkerCommand::Play(sink_id))
    }

    /// Pause playback for an existing sink.
    pub fn pause(&self, sink_id: u32) -> bool {
        self.send_command(AudioWorkerCommand::Pause(sink_id))
    }

    /// Stop playback for an existing sink.
    pub fn stop(&self, sink_id: u32) -> bool {
        self.send_command(AudioWorkerCommand::Stop(sink_id))
    }

    /// Set playback volume for an existing sink.
    pub fn set_volume(&self, sink_id: u32, volume: f32) -> bool {
        self.send_command(AudioWorkerCommand::SetVolume(sink_id, volume))
    }

    /// Load a file into an existing sink.
    pub fn load_file(&self, sink_id: u32, path: String) -> bool {
        self.send_command(AudioWorkerCommand::LoadFile(sink_id, path))
    }

    /// Seek an existing sink to a playback position.
    pub fn seek(&self, sink_id: u32, position: std::time::Duration) -> bool {
        self.send_command(AudioWorkerCommand::Seek(sink_id, position))
    }

    /// Report the timecode position a playing sink should be at, so the worker can seek it
    /// back when the audio actually played has drifted away from the timecode.
    pub fn sync(&self, sink_id: u32, position: std::time::Duration) -> bool {
        self.send_command(AudioWorkerCommand::Sync {
            id: sink_id,
            position,
            sent_at: std::time::Instant::now(),
        })
    }

    /// Rebuild the audio output stream and restore the current sinks on the new device.
    pub(crate) fn reconfigure_output(
        &self,
        device_id: Option<String>,
        sinks: Vec<AudioWorkerSinkState>,
    ) -> bool {
        self.send_command(AudioWorkerCommand::ReconfigureOutput { device_id, sinks })
    }

    fn send_command(&self, command: AudioWorkerCommand) -> bool {
        let maybe_sender = self
            .command_tx
            .lock()
            .ok()
            .and_then(|sender| sender.clone());
        let Some(command_tx) = maybe_sender else {
            return false;
        };

        command_tx.send(command).is_ok()
    }

    pub(crate) fn set_sender(
        &self,
        sender: Option<tokio::sync::mpsc::UnboundedSender<AudioWorkerCommand>>,
    ) {
        if let Ok(mut command_tx) = self.command_tx.lock() {
            *command_tx = sender;
        }
    }
}

#[derive(Debug, Clone)]
/// Commands handled by the audio worker thread.
pub(crate) enum AudioWorkerCommand {
    CreateSink(u32),
    DestroySink(u32),
    Play(u32),
    Pause(u32),
    Stop(u32),
    SetVolume(u32, f32),
    Seek(u32, std::time::Duration),
    LoadFile(u32, String),
    /// Timecode position a playing sink should be at as of `sent_at`.
    Sync {
        id: u32,
        position: std::time::Duration,
        sent_at: std::time::Instant,
    },
    ReconfigureOutput {
        device_id: Option<String>,
        sinks: Vec<AudioWorkerSinkState>,
    },
    Shutdown,
}

/// Audio sink and stream state owned by the playback worker.
#[derive(Debug, Clone)]
pub(crate) struct AudioWorkerSinkState {
    pub(crate) id: u32,
    pub(crate) current_file: Option<String>,
    pub(crate) volume: f32,
    pub(crate) position: Duration,
    pub(crate) is_playing: bool,
}

/// Seek a playing sink to `expected` when the position it has actually played differs from
/// it by more than [`CLOCK_DRIFT_TOLERANCE`], catching late or dropped audio as well as
/// clock drift. `previous` is the played position at the sink's previous sync: when output
/// has not advanced since then the device is stalled, and a seek would wait forever for the
/// output to apply it, so the sink is left alone until output resumes.
fn sync_sink_to_timecode(
    id: u32,
    sink: &rodio::Player,
    previous: Option<Duration>,
    expected: Duration,
) {
    if sink.is_paused() || sink.empty() {
        return;
    }
    let played = sink.get_pos();
    if previous == Some(played) {
        tracing::debug!(
            sink_id = id,
            ?played,
            "Skipping sync while output is stalled"
        );
        return;
    }
    if played.abs_diff(expected) <= CLOCK_DRIFT_TOLERANCE {
        return;
    }
    tracing::debug!(
        sink_id = id,
        ?played,
        ?expected,
        "Resyncing audio sink that drifted from the timecode"
    );
    if let Err(error) = sink.try_seek(expected) {
        tracing::warn!("Failed to resync sink {}: {}", id, error);
    }
}

/// Background worker state for device selection and audio playback commands.
pub(crate) struct AudioWorker {
    /// Command sender used by clients to control sink lifecycle and playback.
    pub(crate) command_tx: tokio::sync::mpsc::UnboundedSender<AudioWorkerCommand>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl AudioWorker {
    pub(crate) fn spawn() -> Option<Self> {
        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let join_handle = std::thread::Builder::new()
            .name("audio-output-service".to_string())
            .spawn(move || {
                let mut stream_handle = match open_output_sink(None) {
                    Ok(handle) => handle,
                    Err(error) => {
                        tracing::warn!("{error}");
                        return;
                    }
                };

                let mut sinks: HashMap<u32, rodio::Player> = HashMap::new();
                // Played position of each sink at its previous timecode sync.
                let mut synced_positions: HashMap<u32, Duration> = HashMap::new();
                loop {
                    maybe_trigger_debug_worker_panic(DebugPanicTarget::AudioThread);

                    if is_process_shutdown_requested() {
                        break;
                    }

                    let command = match command_rx.try_recv() {
                        Ok(command) => command,
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                            std::thread::sleep(AUDIO_WORKER_IDLE_SLEEP);
                            continue;
                        }
                        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
                    };

                    match command {
                        AudioWorkerCommand::CreateSink(id) => {
                            let sink = rodio::Player::connect_new(stream_handle.mixer());
                            sinks.insert(id, sink);
                            tracing::debug!("Created new audio sink: {}", id);
                        }
                        AudioWorkerCommand::DestroySink(id) => {
                            synced_positions.remove(&id);
                            if let Some(sink) = sinks.remove(&id) {
                                tracing::debug!("Destroyed audio sink: {}", id);
                                sink.stop();
                            } else {
                                tracing::warn!("Attempted to destroy non-existent sink: {}", id);
                            }
                        }
                        AudioWorkerCommand::Play(id) => {
                            if let Some(sink) = sinks.get_mut(&id) {
                                tracing::debug!("Playing audio on sink: {}", id);
                                sink.play();
                            } else {
                                tracing::warn!("Attempted to play on non-existent sink: {}", id);
                            }
                        }
                        AudioWorkerCommand::Pause(id) => {
                            if let Some(sink) = sinks.get_mut(&id) {
                                tracing::debug!("Pausing audio on sink: {}", id);
                                sink.pause();
                            } else {
                                tracing::warn!("Attempted to pause non-existent sink: {}", id);
                            }
                        }
                        AudioWorkerCommand::Stop(id) => {
                            if let Some(sink) = sinks.get_mut(&id) {
                                tracing::debug!("Stopping audio on sink: {}", id);
                                sink.stop();
                            } else {
                                tracing::warn!("Attempted to stop non-existent sink: {}", id);
                            }
                        }
                        AudioWorkerCommand::SetVolume(id, volume) => {
                            if let Some(sink) = sinks.get_mut(&id) {
                                tracing::debug!("Setting volume on sink {} to {}", id, volume);
                                sink.set_volume(volume);
                            } else {
                                tracing::warn!(
                                    "Attempted to set volume on non-existent sink: {}",
                                    id
                                );
                            }
                        }
                        AudioWorkerCommand::LoadFile(id, path) => {
                            if let Some(sink) = sinks.get_mut(&id) {
                                if let Ok(file) = std::fs::File::open(&path) {
                                    tracing::debug!(
                                        "Loading audio file '{}' into sink {}",
                                        path,
                                        id
                                    );
                                    if let Ok(source) = rodio::Decoder::try_from(file) {
                                        sink.stop();
                                        sink.append(source);
                                        sink.pause();
                                    } else {
                                        tracing::warn!("Failed to decode audio file: {}", path);
                                    }
                                } else {
                                    tracing::warn!(
                                        "Could not load audio file '{}': file not found",
                                        path
                                    );
                                }
                            } else {
                                tracing::warn!(
                                    "Attempted to load file into non-existent sink: {}",
                                    id
                                );
                            }
                        }
                        AudioWorkerCommand::Seek(id, position) => {
                            if let Some(sink) = sinks.get_mut(&id) {
                                tracing::debug!(
                                    sink_id = id,
                                    ?position,
                                    "Seeking sink"
                                );
                                if let Err(error) = sink.try_seek(position) {
                                    tracing::warn!("Failed to seek sink {}: {}", id, error);
                                }
                            } else {
                                tracing::warn!("Attempted to seek on non-existent sink: {}", id);
                            }
                        }
                        AudioWorkerCommand::Sync {
                            id,
                            position,
                            sent_at,
                        } => {
                            if let Some(sink) = sinks.get_mut(&id) {
                                let previous = synced_positions.insert(id, sink.get_pos());
                                sync_sink_to_timecode(
                                    id,
                                    sink,
                                    previous,
                                    position + sent_at.elapsed(),
                                );
                            }
                        }
                        AudioWorkerCommand::ReconfigureOutput {
                            device_id,
                            sinks: sink_states,
                        } => match open_output_sink(device_id.as_deref()) {
                            Ok(new_stream_handle) => {
                                for (id, sink) in sinks.drain() {
                                    tracing::debug!(
                                        "Cleaning up audio sink {} before output reconfigure",
                                        id
                                    );
                                    sink.stop();
                                }

                                let mut restored_sinks = HashMap::with_capacity(sink_states.len());
                                for state in sink_states {
                                    let sink = rodio::Player::connect_new(new_stream_handle.mixer());

                                    if let Some(path) = &state.current_file {
                                        match std::fs::File::open(path) {
                                            Ok(file) => {
                                                match rodio::Decoder::try_from(file) {
                                                    Ok(source) => {
                                                        sink.stop();
                                                        sink.append(source);
                                                        sink.pause();
                                                    }
                                                    Err(error) => {
                                                        tracing::warn!(
                                                            "Failed to decode audio file '{}' while restoring sink {}: {}",
                                                            path,
                                                            state.id,
                                                            error
                                                        );
                                                    }
                                                }
                                            }
                                            Err(error) => {
                                                tracing::warn!(
                                                    "Failed to reopen audio file '{}' while restoring sink {}: {}",
                                                    path,
                                                    state.id,
                                                    error
                                                );
                                            }
                                        }
                                    }

                                    sink.set_volume(state.volume);
                                    if state.position > Duration::ZERO
                                        && let Err(error) = sink.try_seek(state.position)
                                    {
                                        tracing::warn!(
                                            sink_id = state.id,
                                            position = ?state.position,
                                            error = %error,
                                            "Failed to seek restored sink"
                                        );
                                    }

                                    if state.is_playing {
                                        sink.play();
                                    } else {
                                        sink.pause();
                                    }

                                    restored_sinks.insert(state.id, sink);
                                }

                                stream_handle = new_stream_handle;
                                sinks = restored_sinks;
                                synced_positions.clear();
                                tracing::info!(
                                    "Reconfigured audio output to {}",
                                    device_id.as_deref().unwrap_or("system default")
                                );
                            }
                            Err(error) => {
                                tracing::error!("{error}");
                            }
                        },
                        AudioWorkerCommand::Shutdown => break,
                    }
                }

                for (id, sink) in sinks.drain() {
                    tracing::debug!("Cleaning up audio sink: {}", id);
                    sink.stop();
                }

                tracing::debug!("Audio output service worker exiting");
            })
            .expect("failed to spawn audio output service worker");

        Some(Self {
            command_tx,
            join_handle: Some(join_handle),
        })
    }

    pub(crate) fn shutdown(&mut self) {
        let _ = self.command_tx.send(AudioWorkerCommand::Shutdown);
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.join_handle
            .as_ref()
            .is_some_and(|join_handle| !join_handle.is_finished())
    }
}

/// Process-lifetime audio output service host.
pub struct AudioOutputService {
    slot: WorkerSlot<AudioWorker>,
    client: AudioOutputClient,
}

impl AudioOutputService {
    fn new() -> Self {
        Self {
            slot: WorkerSlot::new(),
            client: AudioOutputClient::default(),
        }
    }

    /// Ensure a process-lifetime audio worker is running.
    pub fn ensure_started(&self) -> bool {
        let has_worker = self.slot.ensure(
            AudioWorker::spawn,
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        let sender = self
            .slot
            .with_worker(|worker| worker.map(|worker| worker.command_tx.clone()));
        self.client.set_sender(sender);
        has_worker
    }

    /// Cloneable audio output client for insertion into ECS worlds.
    pub fn client(&self) -> AudioOutputClient {
        self.client.clone()
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_sender(None);
    }
}

impl Drop for AudioOutputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide audio output service.
pub fn process_audio_output_service() -> &'static AudioOutputService {
    static PROCESS_SERVICE: OnceLock<AudioOutputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, AudioOutputService::new)
}

#[cfg(test)]
mod tests {
    use std::num::NonZero;

    use rodio::buffer::SamplesBuffer;

    use super::*;

    /// Test signal rate, low enough that playing seconds of audio stays cheap.
    const SAMPLE_RATE: u32 = 1_000;

    /// Pull `duration` of samples through a test player, as an output device would.
    fn play_for(output: &mut impl Iterator<Item = f32>, duration: Duration) {
        let samples = duration.as_millis() as u32 * SAMPLE_RATE / 1_000;
        for _ in 0..samples {
            output.next();
        }
    }

    /// Run a timecode sync while output keeps pulling samples, since a seek waits for the
    /// output to apply it.
    fn sync_while_playing(
        player: &rodio::Player,
        output: &mut impl Iterator<Item = f32>,
        expected: Duration,
    ) {
        std::thread::scope(|scope| {
            let sync = scope.spawn(|| sync_sink_to_timecode(1, player, None, expected));
            while !sync.is_finished() {
                output.next();
                std::thread::sleep(Duration::from_micros(50));
            }
        });
    }

    /// Assert the player reports a played position within a few samples of `expected`.
    fn assert_played(player: &rodio::Player, expected: Duration) {
        let played = player.get_pos();
        assert!(
            played.abs_diff(expected) <= Duration::from_millis(60),
            "played {played:?}, expected {expected:?}"
        );
    }

    /// A sink within tolerance of the timecode is left alone, while one that trails it is
    /// seeked to the timecode position and keeps playing from there.
    #[test]
    fn sync_seeks_only_sinks_that_drift_from_the_timecode() {
        let (player, mut output) = rodio::Player::new();
        player.append(SamplesBuffer::new(
            NonZero::new(1).unwrap(),
            NonZero::new(SAMPLE_RATE).unwrap(),
            vec![0.5; 10 * SAMPLE_RATE as usize],
        ));
        play_for(&mut output, Duration::from_secs(1));
        assert_played(&player, Duration::from_secs(1));

        sync_while_playing(&player, &mut output, Duration::from_millis(1_140));
        play_for(&mut output, Duration::from_secs(1));
        assert_played(&player, Duration::from_secs(2));

        sync_while_playing(&player, &mut output, Duration::from_secs(5));
        play_for(&mut output, Duration::from_secs(1));
        assert_played(&player, Duration::from_secs(6));
    }

    /// A sink whose output has not advanced since its previous sync is stalled, so it is
    /// left alone rather than blocking the worker on a seek the output would never apply.
    #[test]
    fn sync_leaves_stalled_sinks_alone() {
        let (player, mut output) = rodio::Player::new();
        player.append(SamplesBuffer::new(
            NonZero::new(1).unwrap(),
            NonZero::new(SAMPLE_RATE).unwrap(),
            vec![0.5; 10 * SAMPLE_RATE as usize],
        ));
        play_for(&mut output, Duration::from_secs(1));

        sync_sink_to_timecode(1, &player, Some(player.get_pos()), Duration::from_secs(5));
        assert_played(&player, Duration::from_secs(1));
    }

    /// MP3 timeline audio, opened the way the worker opens files, can be pulled back when it
    /// runs ahead of the timecode. Decoders built from a bare reader only seek forward.
    #[test]
    fn sync_seeks_mp3_audio_backward() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../app-runtime/assets/sample-audio/lofi.mp3"
        );
        let file = std::fs::File::open(path).expect("sample audio should exist");
        let source = rodio::Decoder::try_from(file).expect("sample audio should decode");
        let (player, mut output) = rodio::Player::new();
        player.append(source);
        // Two seconds of 44.1 kHz stereo.
        for _ in 0..2 * 44_100 * 2 {
            output.next();
        }
        assert_played(&player, Duration::from_secs(2));

        sync_while_playing(&player, &mut output, Duration::from_millis(500));
        assert_played(&player, Duration::from_millis(500));
    }

    /// A paused sink keeps its position, since the timecode is not running for it.
    #[test]
    fn sync_leaves_paused_sinks_alone() {
        let (player, mut output) = rodio::Player::new();
        player.append(SamplesBuffer::new(
            NonZero::new(1).unwrap(),
            NonZero::new(SAMPLE_RATE).unwrap(),
            vec![0.5; 10 * SAMPLE_RATE as usize],
        ));
        play_for(&mut output, Duration::from_secs(1));
        player.pause();

        sync_while_playing(&player, &mut output, Duration::from_secs(5));
        play_for(&mut output, Duration::from_millis(100));
        assert_played(&player, Duration::from_secs(1));
    }
}
