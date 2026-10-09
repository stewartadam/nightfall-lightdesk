// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Offline-first delivery of error reports: envelopes are written to a capped folder in the data
//! directory and a background thread uploads them whenever the error service is reachable.

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    },
    thread::ThreadId,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use reqwest::{StatusCode, header};
use sentry::{Envelope, Transport};

/// File extension of a queued envelope; anything else in the folder is ignored.
const ENVELOPE_EXTENSION: &str = "envelope";
/// Most envelopes kept waiting; older ones are dropped first.
const MAX_QUEUED_FILES: usize = 50;
/// Most bytes kept waiting; older envelopes are dropped first.
const MAX_QUEUED_BYTES: u64 = 2 * 1024 * 1024;
/// Envelopes larger than this are never queued.
const MAX_ENVELOPE_BYTES: usize = 512 * 1024;
/// Most reports accepted from one session, so a failure that repeats for hours cannot fill
/// the queue with copies.
const MAX_REPORTS_PER_SESSION: usize = 50;
/// Envelopes waiting in memory for the background thread before new ones are dropped.
const CHANNEL_CAPACITY: usize = 32;
/// First wait after a failed upload; doubles on each further failure.
const INITIAL_BACKOFF: Duration = Duration::from_secs(30);
/// Longest wait between upload attempts while the service stays unreachable.
const MAX_BACKOFF: Duration = Duration::from_secs(60 * 60);
/// Time allowed to connect to the error service.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Time allowed for one upload, including the response.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Orders envelopes written within the same millisecond.
static WRITE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

/// Work handed to the background thread.
enum Command {
    /// A serialized envelope to persist.
    Store(Vec<u8>),
    /// Consent was granted: upload whatever is waiting.
    Wake,
    /// Consent was withdrawn: delete everything waiting.
    Purge,
    /// Acknowledges once every earlier command has been handled.
    Flush(SyncSender<()>),
}

/// The folder of envelopes waiting to be uploaded, oldest first by file name.
#[derive(Debug, Clone)]
pub(super) struct OutboxStore {
    dir: PathBuf,
}

impl OutboxStore {
    /// Uses `dir` for queued envelopes; it is created on the first write.
    pub(super) fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Writes one envelope atomically under a name that sorts after every earlier one, then
    /// drops the oldest envelopes beyond the queue limits.
    pub(super) fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            "{millis:016}-{sequence:010}-{}.{ENVELOPE_EXTENSION}",
            uuid::Uuid::new_v4()
        );
        let mut file = tempfile::NamedTempFile::new_in(&self.dir)?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        file.persist(self.dir.join(name))?;
        self.trim();
        Ok(())
    }

    /// Lists queued envelopes, oldest first.
    pub(super) fn pending(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|ext| ext == ENVELOPE_EXTENSION)
            })
            .collect();
        files.sort();
        files
    }

    /// Deletes the oldest envelopes until the queue fits its count and size limits.
    fn trim(&self) {
        let files = self.pending();
        let sizes: Vec<u64> = files
            .iter()
            .map(|path| std::fs::metadata(path).map_or(0, |meta| meta.len()))
            .collect();
        let mut total: u64 = sizes.iter().sum();
        let mut count = files.len();
        for (path, size) in files.iter().zip(sizes) {
            if count <= MAX_QUEUED_FILES && total <= MAX_QUEUED_BYTES {
                break;
            }
            let _ = std::fs::remove_file(path);
            count -= 1;
            total -= size;
        }
    }

    /// Deletes every queued envelope.
    pub(super) fn purge(&self) {
        for path in self.pending() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// What the error service said about one upload.
#[derive(Debug, PartialEq, Eq)]
enum UploadOutcome {
    /// Accepted: the envelope can be deleted.
    Accepted,
    /// Refused for good (malformed or too large): retrying cannot help, so it is deleted.
    Rejected,
    /// Rate limited: try again after the given delay, or the backoff when none was given.
    RetryAfter(Option<Duration>),
    /// Unreachable or failing: keep the envelope and back off.
    Unavailable,
}

/// Maps an HTTP response to what should happen to the envelope.
fn classify(status: StatusCode, retry_after: Option<&str>) -> UploadOutcome {
    if status.is_success() {
        UploadOutcome::Accepted
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        UploadOutcome::RetryAfter(
            retry_after
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs),
        )
    } else if status.is_client_error()
        && status != StatusCode::REQUEST_TIMEOUT
        && status != StatusCode::UNAUTHORIZED
        && status != StatusCode::FORBIDDEN
    {
        UploadOutcome::Rejected
    } else {
        UploadOutcome::Unavailable
    }
}

/// Where and how envelopes are uploaded.
#[derive(Debug, Clone)]
pub(super) struct Endpoint {
    pub(super) url: String,
    pub(super) auth: String,
}

/// State shared between the SDK-facing transport and the background thread.
struct Shared {
    sender: SyncSender<Command>,
    store: OutboxStore,
    worker: OnceLock<ThreadId>,
    accepted: AtomicUsize,
}

/// Handle to the outbox, used both as the SDK transport and to apply consent changes.
#[derive(Clone)]
pub(super) struct Outbox {
    shared: Arc<Shared>,
}

impl Outbox {
    /// Starts the background thread that persists and uploads envelopes for `endpoint`.
    pub(super) fn start(store: OutboxStore, endpoint: Endpoint) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);
        let shared = Arc::new(Shared {
            sender,
            store: store.clone(),
            worker: OnceLock::new(),
            accepted: AtomicUsize::new(0),
        });
        let handle = std::thread::Builder::new()
            .name("nightfall-error-reports".into())
            .spawn(move || Worker::new(store, endpoint).run(receiver))?;
        let _ = shared.worker.set(handle.thread().id());
        Ok(Self { shared })
    }

    /// Asks the background thread to upload what is waiting, after consent is granted.
    pub(super) fn wake(&self) {
        let _ = self.shared.sender.try_send(Command::Wake);
    }

    /// Deletes everything waiting, after consent is withdrawn. The background thread repeats the
    /// deletion once it reaches the request, catching an envelope it was writing meanwhile, and
    /// discards envelopes still queued in memory.
    pub(super) fn purge(&self) {
        self.shared.store.purge();
        let _ = self.shared.sender.try_send(Command::Purge);
    }
}

impl Transport for Outbox {
    /// Queues an envelope for the background thread. While the process is panicking it is
    /// written to disk directly, since the process may stop before the thread runs again.
    fn send_envelope(&self, envelope: Envelope) {
        if !super::reports_enabled()
            || self.shared.accepted.fetch_add(1, Ordering::Relaxed) >= MAX_REPORTS_PER_SESSION
        {
            return;
        }
        let mut bytes = Vec::new();
        if envelope.to_writer(&mut bytes).is_err() {
            return;
        }
        if std::thread::panicking() {
            let _ = self.shared.store.write(&bytes);
            self.wake();
            return;
        }
        if let Err(TrySendError::Full(_)) = self.shared.sender.try_send(Command::Store(bytes)) {
            tracing::debug!("Error report queue is full; dropping a report");
        }
    }

    /// Waits until every envelope handed over so far is on disk. Uploads are not awaited, since
    /// the service may be unreachable for days.
    fn flush(&self, timeout: Duration) -> bool {
        if self.shared.worker.get() == Some(&std::thread::current().id()) {
            return true;
        }
        let (ack, done) = mpsc::sync_channel(1);
        if self.shared.sender.try_send(Command::Flush(ack)).is_err() {
            return false;
        }
        done.recv_timeout(timeout).is_ok()
    }
}

/// The background thread: persists envelopes and uploads the queue with backoff.
struct Worker {
    store: OutboxStore,
    endpoint: Endpoint,
    client: Option<reqwest::Client>,
    runtime: Option<tokio::runtime::Runtime>,
    backoff: Duration,
    next_attempt: Option<Instant>,
}

impl Worker {
    /// Prepares the uploader; the HTTP client is built lazily on the first upload.
    fn new(store: OutboxStore, endpoint: Endpoint) -> Self {
        Self {
            store,
            endpoint,
            client: None,
            runtime: None,
            backoff: INITIAL_BACKOFF,
            next_attempt: Some(Instant::now()),
        }
    }

    /// Handles commands until the transport is dropped, uploading whenever reports are enabled,
    /// something is waiting, and any backoff has elapsed.
    fn run(mut self, receiver: Receiver<Command>) {
        loop {
            let command = match self.wait_time() {
                None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(wait) => receiver.recv_timeout(wait),
            };
            match command {
                Ok(Command::Store(_)) if !super::reports_enabled() => continue,
                Ok(Command::Store(bytes)) => {
                    if let Err(error) = self.store.write(&bytes) {
                        tracing::debug!(%error, "Could not queue an error report");
                    }
                    self.next_attempt.get_or_insert_with(Instant::now);
                }
                Ok(Command::Wake) => {
                    self.next_attempt.get_or_insert_with(Instant::now);
                }
                Ok(Command::Purge) => {
                    self.store.purge();
                    self.next_attempt = None;
                    self.backoff = INITIAL_BACKOFF;
                }
                Ok(Command::Flush(ack)) => {
                    let _ = ack.send(());
                    continue;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if self.next_attempt.is_some_and(|at| at <= Instant::now()) {
                self.upload_pending();
            }
        }
    }

    /// Returns how long to sleep before the next upload attempt, or `None` to wait for a command.
    fn wait_time(&self) -> Option<Duration> {
        if !super::reports_enabled() {
            return None;
        }
        self.next_attempt
            .map(|at| at.saturating_duration_since(Instant::now()))
    }

    /// Uploads queued envelopes oldest first, stopping at the first failure and scheduling a
    /// retry with exponential backoff.
    fn upload_pending(&mut self) {
        for path in self.store.pending() {
            if !super::reports_enabled() {
                return;
            }
            match self.upload(&path) {
                UploadOutcome::Accepted | UploadOutcome::Rejected => {
                    let _ = std::fs::remove_file(&path);
                    self.backoff = INITIAL_BACKOFF;
                }
                UploadOutcome::RetryAfter(delay) => {
                    let delay = delay.unwrap_or(self.backoff).min(MAX_BACKOFF);
                    self.next_attempt = Some(Instant::now() + delay);
                    return;
                }
                UploadOutcome::Unavailable => {
                    self.next_attempt = Some(Instant::now() + self.backoff);
                    self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
                    return;
                }
            }
        }
        self.next_attempt = None;
    }

    /// Sends one envelope file and reports what the service said about it.
    fn upload(&mut self, path: &Path) -> UploadOutcome {
        let Ok(body) = std::fs::read(path) else {
            return UploadOutcome::Rejected;
        };
        let Endpoint { url, auth } = self.endpoint.clone();
        let Some((runtime, client)) = self.http() else {
            return UploadOutcome::Unavailable;
        };
        let request = client
            .post(url)
            .header("X-Sentry-Auth", auth)
            .header(header::CONTENT_TYPE, "application/x-sentry-envelope")
            .body(body);
        match runtime.block_on(async { request.send().await }) {
            Ok(response) => {
                let retry_after = response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok());
                let outcome = classify(response.status(), retry_after);
                tracing::debug!(status = %response.status(), ?outcome, "Uploaded an error report");
                outcome
            }
            Err(error) => {
                tracing::debug!(%error, "Could not reach the error report service");
                UploadOutcome::Unavailable
            }
        }
    }

    /// Returns the runtime and HTTP client, building them on first use.
    fn http(&mut self) -> Option<(&tokio::runtime::Runtime, &reqwest::Client)> {
        if self.runtime.is_none() {
            self.runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok();
        }
        if let (None, Some(runtime)) = (&self.client, &self.runtime) {
            let _context = runtime.enter();
            self.client = reqwest::Client::builder()
                .https_only(self.endpoint.url.starts_with("https:"))
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .build()
                .ok();
        }
        Some((self.runtime.as_ref()?, self.client.as_ref()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Queued envelopes come back oldest first and survive until uploaded or purged.
    #[test]
    fn store_lists_envelopes_oldest_first() {
        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().join("outbox"));
        store.write(b"first").unwrap();
        std::thread::sleep(Duration::from_millis(2));
        store.write(b"second").unwrap();
        std::fs::write(directory.path().join("outbox/notes.txt"), b"ignored").unwrap();
        let pending = store.pending();
        assert_eq!(pending.len(), 2);
        assert_eq!(std::fs::read(&pending[0]).unwrap(), b"first");
        assert_eq!(std::fs::read(&pending[1]).unwrap(), b"second");
        store.purge();
        assert!(store.pending().is_empty());
    }

    /// A long offline stretch keeps only the newest envelopes within the count limit.
    #[test]
    fn store_drops_oldest_beyond_the_limit() {
        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().to_path_buf());
        for index in 0..MAX_QUEUED_FILES + 5 {
            store.write(format!("{index:04}").as_bytes()).unwrap();
        }
        let pending = store.pending();
        assert_eq!(pending.len(), MAX_QUEUED_FILES);
        let oldest = std::fs::read_to_string(&pending[0]).unwrap();
        assert!(oldest.as_str() >= "0005", "kept {oldest}");
    }

    /// Oversized envelopes are never written.
    #[test]
    fn store_skips_oversized_envelopes() {
        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().to_path_buf());
        store.write(&vec![0; MAX_ENVELOPE_BYTES + 1]).unwrap();
        assert!(store.pending().is_empty());
    }

    /// Reports left on disk by an earlier session are uploaded with the service's credentials
    /// once sharing is on, and deleted after the service accepts them.
    #[test]
    fn uploads_queued_reports_once_enabled() {
        let _consent = crate::error_reports::CONSENT_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (received, uploads) = mpsc::channel();
        let app = axum::Router::new().route(
            "/api/1/envelope/",
            axum::routing::post(move |headers: axum::http::HeaderMap, body: String| {
                let auth = headers
                    .get("x-sentry-auth")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                received.send((auth, body)).unwrap();
                async { StatusCode::OK }
            }),
        );
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let address = listener.local_addr().unwrap();
        runtime.spawn(async move { axum::serve(listener, app).await });

        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().to_path_buf());
        store.write(b"queued while offline").unwrap();
        crate::error_reports::ENABLED.store(true, Ordering::Relaxed);
        let outbox = Outbox::start(
            store.clone(),
            Endpoint {
                url: format!("http://{address}/api/1/envelope/"),
                auth: "Sentry sentry_key=test".into(),
            },
        )
        .unwrap();
        outbox.wake();

        let upload = uploads.recv_timeout(Duration::from_secs(10));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !store.pending().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        crate::error_reports::ENABLED.store(false, Ordering::Relaxed);
        assert_eq!(
            upload.unwrap(),
            (
                Some("Sentry sentry_key=test".to_owned()),
                "queued while offline".to_owned()
            )
        );
        assert!(store.pending().is_empty());
    }

    /// Server responses decide whether an envelope is deleted, retried later, or rate limited.
    #[test]
    fn classifies_service_responses() {
        assert_eq!(classify(StatusCode::OK, None), UploadOutcome::Accepted);
        assert_eq!(
            classify(StatusCode::PAYLOAD_TOO_LARGE, None),
            UploadOutcome::Rejected
        );
        assert_eq!(
            classify(StatusCode::TOO_MANY_REQUESTS, Some("120")),
            UploadOutcome::RetryAfter(Some(Duration::from_secs(120)))
        );
        assert_eq!(
            classify(StatusCode::TOO_MANY_REQUESTS, Some("soon")),
            UploadOutcome::RetryAfter(None)
        );
        assert_eq!(
            classify(StatusCode::FORBIDDEN, None),
            UploadOutcome::Unavailable
        );
        assert_eq!(
            classify(StatusCode::BAD_GATEWAY, None),
            UploadOutcome::Unavailable
        );
    }
}
