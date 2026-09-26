// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Explicit, cancellable installation of optional beat-detection weights.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    routing::{delete, get},
};
use nightfall_timeline::beat_model;
use nightfall_websocket::prelude::HttpRouteRegistry;
use serde::Serialize;
use tokio::{io::AsyncWriteExt, sync::watch};

const NOTICE: &str = include_str!("../../../webui/assets/models/beat-this/NOTICE.md");

/// Installation state returned to every connected authoring client.
#[derive(Clone, Serialize)]
struct ModelStatus {
    phase: Phase,
    received_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
}

/// Explicit lifecycle phases keep polling clients from starting duplicate downloads.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Unchecked,
    Checking,
    Missing,
    Downloading,
    Cancelling,
    Deleting,
    Ready,
    Failed,
    Cancelled,
}

/// Mutable status and cancellation channel protected as one transition boundary.
struct Installation {
    status: ModelStatus,
    cancel: Option<watch::Sender<bool>>,
}

/// One installation coordinator shared by the native backend's HTTP routes.
struct ModelManager {
    installation: Mutex<Installation>,
    destination: Result<PathBuf, String>,
    url: String,
    size: u64,
    digest: String,
}

impl ModelManager {
    /// Capture the pinned model and persistent location without touching the network.
    fn new() -> Arc<Self> {
        let manifest = beat_model::manifest();
        Arc::new(Self {
            installation: Mutex::new(Installation {
                status: ModelStatus {
                    phase: Phase::Unchecked,
                    received_bytes: 0,
                    total_bytes: manifest.size_bytes,
                    error: None,
                },
                cancel: None,
            }),
            destination: beat_model::model_path(),
            url: manifest.url.clone(),
            size: manifest.size_bytes,
            digest: manifest.sha256.clone(),
        })
    }

    /// Return a consistent snapshot without exposing download implementation details.
    fn status(&self) -> ModelStatus {
        self.installation
            .lock()
            .expect("model status mutex")
            .status
            .clone()
    }

    /// Verify an existing installation off the HTTP executor on the first status request.
    fn check(self: &Arc<Self>) {
        let mut installation = self.installation.lock().expect("model status mutex");
        if installation.status.phase != Phase::Unchecked {
            return;
        }
        installation.status.phase = Phase::Checking;
        let manager = self.clone();
        tokio::spawn(async move {
            let verifier = manager.clone();
            let result = tokio::task::spawn_blocking(move || {
                let path = verifier.destination.as_ref().map_err(Clone::clone)?;
                if !path.exists() {
                    return Ok(false);
                }
                beat_model::verify(path, verifier.size, &verifier.digest).map(|_| true)
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
            let mut installation = manager.installation.lock().expect("model status mutex");
            installation.status.phase = match result {
                Ok(true) => Phase::Ready,
                Ok(false) => Phase::Missing,
                Err(error) => {
                    installation.status.error = Some(error);
                    Phase::Failed
                }
            };
        });
    }

    /// Start one explicit download and retain cancellation until its cleanup completes.
    fn start(self: &Arc<Self>) -> Result<ModelStatus, (StatusCode, String)> {
        let mut installation = self.installation.lock().expect("model status mutex");
        match installation.status.phase {
            Phase::Unchecked | Phase::Checking | Phase::Cancelling | Phase::Deleting => {
                return Err((
                    StatusCode::CONFLICT,
                    "Model availability is still being checked".into(),
                ));
            }
            Phase::Ready | Phase::Downloading => return Ok(installation.status.clone()),
            _ => {}
        }
        let (cancel, mut cancelled) = watch::channel(false);
        installation.cancel = Some(cancel);
        installation.status.phase = Phase::Downloading;
        installation.status.received_bytes = 0;
        installation.status.error = None;
        let manager = self.clone();
        tokio::spawn(async move {
            let outcome = tokio::select! {
                result = manager.download() => Some(result),
                _ = cancelled.changed() => None,
            };
            let mut installation = manager.installation.lock().expect("model status mutex");
            installation.cancel = None;
            installation.status.phase = match outcome {
                Some(Ok(())) => Phase::Ready,
                Some(Err(error)) => {
                    installation.status.error = Some(error);
                    Phase::Failed
                }
                None => Phase::Cancelled,
            };
        });
        Ok(installation.status.clone())
    }

    /// Stop the active transfer; a subsequent start is allowed only after temporary-file cleanup.
    fn cancel(&self) -> ModelStatus {
        let mut installation = self.installation.lock().expect("model status mutex");
        if let Some(cancel) = installation.cancel.as_ref() {
            let _ = cancel.send(true);
            installation.status.phase = Phase::Cancelling;
        }
        installation.status.clone()
    }

    /// Remove cached weights off the executor while excluding downloads and verification.
    fn remove(self: &Arc<Self>) -> Result<ModelStatus, (StatusCode, String)> {
        let mut installation = self.installation.lock().expect("model status mutex");
        if matches!(
            installation.status.phase,
            Phase::Unchecked
                | Phase::Checking
                | Phase::Downloading
                | Phase::Cancelling
                | Phase::Deleting
        ) {
            return Err((
                StatusCode::CONFLICT,
                "Model operation already in progress".into(),
            ));
        }
        let destination = self
            .destination
            .as_ref()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.clone()))?
            .clone();
        let previous_phase = installation.status.phase;
        installation.status.phase = Phase::Deleting;
        installation.status.error = None;
        let manager = self.clone();
        tokio::spawn(async move {
            let result = tokio::fs::remove_file(destination).await;
            let mut installation = manager.installation.lock().expect("model status mutex");
            match result {
                Ok(()) => {
                    installation.status.phase = Phase::Missing;
                    installation.status.received_bytes = 0;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    installation.status.phase = Phase::Missing;
                    installation.status.received_bytes = 0;
                }
                Err(error) => {
                    installation.status.phase = previous_phase;
                    installation.status.error = Some(error.to_string());
                }
            }
        });
        Ok(installation.status.clone())
    }

    /// Stream bounded weights into a temporary file, verify them, and atomically install with attribution.
    async fn download(&self) -> Result<(), String> {
        let destination = self.destination.as_ref().map_err(Clone::clone)?;
        let directory = destination.parent().ok_or("Invalid model destination")?;
        tokio::fs::create_dir_all(directory)
            .await
            .map_err(|error| error.to_string())?;
        let temporary =
            tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
        let mut writer =
            tokio::fs::File::from_std(temporary.reopen().map_err(|error| error.to_string())?);
        let client = reqwest::Client::builder()
            .https_only(self.url.starts_with("https:"))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|error| error.to_string())?;
        let mut response = client
            .get(&self.url)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        if response
            .content_length()
            .is_some_and(|size| size != self.size)
        {
            return Err("Beat detection model has an unexpected download size".into());
        }
        let mut received = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or("Model download size overflow")?;
            if received > self.size {
                return Err("Beat detection model exceeds expected size".into());
            }
            writer
                .write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
            self.installation
                .lock()
                .expect("model status mutex")
                .status
                .received_bytes = received;
        }
        writer.sync_all().await.map_err(|error| error.to_string())?;
        drop(writer);
        let path = temporary.path().to_path_buf();
        let (size, digest) = (self.size, self.digest.clone());
        tokio::task::spawn_blocking(move || beat_model::verify(&path, size, &digest))
            .await
            .map_err(|error| error.to_string())??;
        tokio::fs::write(directory.join("NOTICE.md"), NOTICE)
            .await
            .map_err(|error| error.to_string())?;
        temporary
            .persist(destination)
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

/// Register installation controls without fetching any remote data at app startup.
pub(crate) fn register_routes(registry: &mut HttpRouteRegistry) {
    let manager = ModelManager::new();
    registry.register(
        "/api/beat-detection/model/cache",
        delete(remove).with_state(manager.clone()),
    );
    registry.register(
        "/api/beat-detection/model",
        get(status)
            .post(download)
            .delete(cancel)
            .with_state(manager),
    );
}

/// Poll availability and progress, lazily checking existing weights without downloading.
async fn status(State(manager): State<Arc<ModelManager>>) -> Json<ModelStatus> {
    manager.check();
    Json(manager.status())
}

/// Explicit user consent starts or joins the backend's single model download.
async fn download(
    State(manager): State<Arc<ModelManager>>,
) -> Result<Json<ModelStatus>, (StatusCode, String)> {
    manager.start().map(Json)
}

/// Cancel an in-progress transfer without deleting an already installed model.
async fn cancel(State(manager): State<Arc<ModelManager>>) -> Json<ModelStatus> {
    Json(manager.cancel())
}

/// Delete only the optional cached weights, preserving attribution and other application data.
async fn remove(
    State(manager): State<Arc<ModelManager>>,
) -> Result<Json<ModelStatus>, (StatusCode, String)> {
    manager.remove().map(Json)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{Router, body::Body, response::Response};

    use super::*;

    const PAYLOAD: &[u8] = b"verified model";
    const DIGEST: &str = "6c736b3dfa943bf4e7c61df78d1dfcad9a3d8b56369f0559670497b19127e74d";

    /// Build an isolated coordinator with a loopback source and no production filesystem state.
    fn manager(root: &std::path::Path, url: String) -> Arc<ModelManager> {
        Arc::new(ModelManager {
            installation: Mutex::new(Installation {
                status: ModelStatus {
                    phase: Phase::Unchecked,
                    received_bytes: 0,
                    total_bytes: PAYLOAD.len() as u64,
                    error: None,
                },
                cancel: None,
            }),
            destination: Ok(root.join("model/beat_this.onnx")),
            url,
            size: PAYLOAD.len() as u64,
            digest: DIGEST.into(),
        })
    }

    /// Bound asynchronous state assertions so a broken download cannot hang the test suite.
    async fn wait_for(manager: &ModelManager, phase: Phase) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while manager.status().phase != phase {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("model phase transition");
    }

    /// Serve deterministic fixture bytes, optionally delaying or corrupting the first transfer.
    async fn server(
        calls: Arc<AtomicUsize>,
        corrupt_first: bool,
        delay: bool,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route(
            "/model",
            get(move || {
                let calls = calls.clone();
                async move {
                    let count = calls.fetch_add(1, Ordering::SeqCst);
                    if delay {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                    let bytes = if corrupt_first && count == 0 {
                        vec![b'x'; PAYLOAD.len()]
                    } else {
                        PAYLOAD.to_vec()
                    };
                    Response::builder().body(Body::from(bytes)).unwrap()
                }
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{address}/model"), task)
    }

    /// Availability checks stay offline, concurrent starts coalesce, and a verified installation survives a restart.
    #[tokio::test]
    async fn explicit_download_installs_once_and_is_reused_offline() {
        let root = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let (url, server) = server(calls.clone(), false, false).await;
        let model = manager(root.path(), url.clone());
        model.check();
        wait_for(&model, Phase::Missing).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        model.start().unwrap();
        model.start().unwrap();
        wait_for(&model, Phase::Ready).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read(model.destination.as_ref().unwrap()).unwrap(),
            PAYLOAD
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("model/NOTICE.md")).unwrap(),
            NOTICE
        );
        server.abort();
        let restarted = manager(root.path(), url);
        restarted.check();
        wait_for(&restarted, Phase::Ready).await;
    }

    /// Removing installed weights resets availability and permits a fresh explicit download.
    #[tokio::test]
    async fn deletion_removes_weights_and_allows_redownload() {
        let root = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let (url, server) = server(calls.clone(), false, false).await;
        let model = manager(root.path(), url);
        assert!(model.remove().is_err());
        model.check();
        wait_for(&model, Phase::Missing).await;
        model.start().unwrap();
        wait_for(&model, Phase::Ready).await;
        model.remove().unwrap();
        wait_for(&model, Phase::Missing).await;
        assert!(!model.destination.as_ref().unwrap().exists());
        assert_eq!(model.status().received_bytes, 0);
        model.remove().unwrap();
        wait_for(&model, Phase::Missing).await;
        model.start().unwrap();
        wait_for(&model, Phase::Ready).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }

    /// Failed deletion preserves installed availability and reports the filesystem error for retry.
    #[tokio::test]
    async fn deletion_failure_preserves_installed_status() {
        let root = tempfile::tempdir().unwrap();
        let model = manager(root.path(), "http://unused.invalid".into());
        std::fs::create_dir_all(model.destination.as_ref().unwrap()).unwrap();
        model.installation.lock().unwrap().status.phase = Phase::Ready;
        model.remove().unwrap();
        wait_for(&model, Phase::Ready).await;
        assert!(model.status().error.is_some());
        assert!(model.destination.as_ref().unwrap().is_dir());
    }

    /// Checksum failures never install bytes, leave no partial file, and can be retried successfully.
    #[tokio::test]
    async fn corrupted_download_is_rejected_and_retry_succeeds() {
        let root = tempfile::tempdir().unwrap();
        let (url, server) = server(Arc::new(AtomicUsize::new(0)), true, false).await;
        let model = manager(root.path(), url);
        model.check();
        wait_for(&model, Phase::Missing).await;
        model.start().unwrap();
        wait_for(&model, Phase::Failed).await;
        assert!(model.status().error.unwrap().contains("checksum"));
        assert!(!model.destination.as_ref().unwrap().exists());
        assert_eq!(
            std::fs::read_dir(root.path().join("model"))
                .unwrap()
                .count(),
            0
        );
        model.start().unwrap();
        wait_for(&model, Phase::Ready).await;
        server.abort();
    }

    /// Cancelling a stalled server releases the transfer and cleans temporary files before allowing a retry.
    #[tokio::test]
    async fn cancellation_cleans_partial_download() {
        let root = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let (url, server) = server(calls.clone(), false, true).await;
        let model = manager(root.path(), url);
        model.check();
        wait_for(&model, Phase::Missing).await;
        model.start().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(model.remove().is_err());
        model.cancel();
        wait_for(&model, Phase::Cancelled).await;
        assert!(!model.destination.as_ref().unwrap().exists());
        assert_eq!(
            std::fs::read_dir(root.path().join("model"))
                .unwrap()
                .count(),
            0
        );
        server.abort();
    }
}
