// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Offline-first delivery of telemetry reports: each report is written to a capped folder in the
//! data directory and a background thread uploads it whenever its service is reachable. Error
//! reports and usage reports each run their own outbox.

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    },
    thread::ThreadId,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use reqwest::{StatusCode, header};

/// File extension of a queued report; anything else in the folder is ignored. Error reports
/// queued by earlier versions use it too.
const REPORT_EXTENSION: &str = "envelope";
/// Reports larger than this are never queued.
const MAX_REPORT_BYTES: usize = 512 * 1024;
/// Reports waiting in memory for the background thread before new ones are dropped.
const CHANNEL_CAPACITY: usize = 32;
/// First wait after a failed upload; doubles on each further failure.
const INITIAL_BACKOFF: Duration = Duration::from_secs(30);
/// Longest wait between upload attempts while the service stays unreachable.
const MAX_BACKOFF: Duration = Duration::from_secs(60 * 60);
/// Time allowed to connect to the service.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Time allowed for one upload, including the response.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Orders reports written within the same millisecond.
static WRITE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

/// Work handed to the background thread.
enum Command {
    /// Serialized reports to persist.
    Store(Vec<Vec<u8>>),
    /// Consent was granted: upload whatever is waiting.
    Wake,
    /// Consent was withdrawn: delete everything waiting.
    Purge,
    /// Acknowledges once every earlier command has been handled.
    Flush(SyncSender<()>),
}

/// How many reports one outbox keeps.
#[derive(Debug, Clone, Copy)]
pub(crate) struct OutboxLimits {
    /// Most reports kept waiting; older ones are dropped first.
    pub(crate) max_files: usize,
    /// Most bytes kept waiting; older reports are dropped first.
    pub(crate) max_bytes: u64,
    /// Most reports accepted from one session, so a failure that repeats for hours cannot fill
    /// the queue with copies.
    pub(crate) max_per_session: usize,
}

/// The folder of reports waiting to be uploaded, oldest first by file name, together with the
/// operator's current choice about sharing them.
#[derive(Debug, Clone)]
pub(crate) struct OutboxStore {
    dir: PathBuf,
    enabled: &'static AtomicBool,
    limits: OutboxLimits,
}

impl OutboxStore {
    /// Uses `dir` for queued reports, which is created on the first write. Reports are kept and
    /// uploaded only while `enabled` is set.
    pub(crate) fn new(dir: PathBuf, enabled: &'static AtomicBool, limits: OutboxLimits) -> Self {
        Self {
            dir,
            enabled,
            limits,
        }
    }

    /// Returns whether the operator currently shares these reports.
    fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Writes one report, then drops the oldest reports beyond the queue limits. Returns the new
    /// file, or `None` when the report was too large to keep.
    #[cfg(test)]
    fn write(&self, bytes: &[u8]) -> std::io::Result<Option<PathBuf>> {
        let path = self.write_file(bytes)?;
        self.trim();
        Ok(path)
    }

    /// Writes one report atomically under a name that sorts after every earlier one. Returns the
    /// new file, or `None` when the report was too large to keep.
    fn write_file(&self, bytes: &[u8]) -> std::io::Result<Option<PathBuf>> {
        if bytes.len() > MAX_REPORT_BYTES {
            return Ok(None);
        }
        std::fs::create_dir_all(&self.dir)?;
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            "{millis:016}-{sequence:010}-{}.{REPORT_EXTENSION}",
            uuid::Uuid::new_v4()
        );
        let mut file = tempfile::NamedTempFile::new_in(&self.dir)?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        let path = self.dir.join(name);
        file.persist(&path)?;
        Ok(Some(path))
    }

    /// Lists queued reports, oldest first.
    pub(crate) fn pending(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == REPORT_EXTENSION))
            .collect();
        files.sort();
        files
    }

    /// Deletes the oldest reports until the queue fits its count and size limits.
    fn trim(&self) {
        let files = self.pending();
        let sizes: Vec<u64> = files
            .iter()
            .map(|path| std::fs::metadata(path).map_or(0, |meta| meta.len()))
            .collect();
        let mut total: u64 = sizes.iter().sum();
        let mut count = files.len();
        for (path, size) in files.iter().zip(sizes) {
            if count <= self.limits.max_files && total <= self.limits.max_bytes {
                break;
            }
            let _ = std::fs::remove_file(path);
            count -= 1;
            total -= size;
        }
    }

    /// Deletes every queued report, along with temporary files a crash left mid-write.
    pub(crate) fn purge(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Writes reports captured while reports were shared and trims the queue once, deleting
    /// them again if sharing was turned off during the write so a revoked report never waits
    /// for the next agreement.
    fn persist(&self, reports: &[Vec<u8>]) {
        let mut written = Vec::new();
        for bytes in reports {
            match self.write_file(bytes) {
                Ok(path) => written.extend(path),
                Err(error) => {
                    tracing::debug!(%error, dir = %self.dir.display(), "Could not queue a report");
                }
            }
        }
        self.trim();
        if !self.enabled() {
            for path in written {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// What the error service said about one upload.
#[derive(Debug, PartialEq, Eq)]
enum UploadOutcome {
    /// Accepted: the report can be deleted.
    Accepted,
    /// Refused for good (malformed or too large): retrying cannot help, so it is deleted.
    Rejected,
    /// Rate limited: try again after the given delay, or the backoff when none was given.
    RetryAfter(Option<Duration>),
    /// Unreachable or failing: keep the report and back off.
    Unavailable,
}

/// Maps an HTTP response to what should happen to the report.
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

/// Where and how reports are uploaded.
#[derive(Debug, Clone)]
pub(crate) struct Endpoint {
    /// Address each report is posted to.
    pub(crate) url: String,
    /// Credentials and other headers sent with every upload.
    pub(crate) headers: Vec<(&'static str, String)>,
    /// Media type of the report bodies.
    pub(crate) content_type: &'static str,
}

/// State shared between the producers and the background thread.
struct Shared {
    sender: SyncSender<Command>,
    store: OutboxStore,
    worker: OnceLock<ThreadId>,
    accepted: AtomicUsize,
}

/// Handle used to queue reports and to apply consent changes.
#[derive(Clone)]
pub(crate) struct Outbox {
    shared: Arc<Shared>,
}

impl Outbox {
    /// Starts the background thread, named `thread_name`, that persists and uploads reports for
    /// `endpoint`.
    pub(crate) fn start(
        store: OutboxStore,
        endpoint: Endpoint,
        thread_name: &str,
    ) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);
        let shared = Arc::new(Shared {
            sender,
            store: store.clone(),
            worker: OnceLock::new(),
            accepted: AtomicUsize::new(0),
        });
        let handle = std::thread::Builder::new()
            .name(thread_name.into())
            .spawn(move || Worker::new(store, endpoint).run(receiver))?;
        let _ = shared.worker.set(handle.thread().id());
        Ok(Self { shared })
    }

    /// Hands reports to the background thread as one batch, kept or dropped whole. Returns
    /// whether the batch was accepted: it is not while sharing is off, when it would exceed the
    /// session budget, or when the in-memory queue is full.
    pub(crate) fn queue(&self, reports: Vec<Vec<u8>>) -> bool {
        if !self.shared.store.enabled() || reports.is_empty() {
            return false;
        }
        let count = reports.len();
        let budget = self.shared.store.limits.max_per_session;
        if self
            .shared
            .accepted
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |accepted| {
                (accepted + count <= budget).then_some(accepted + count)
            })
            .is_err()
        {
            return false;
        }
        match self.shared.sender.try_send(Command::Store(reports)) {
            Ok(()) => true,
            Err(_) => {
                self.shared.accepted.fetch_sub(count, Ordering::Relaxed);
                tracing::debug!("Report queue is full; dropping reports");
                false
            }
        }
    }

    /// Writes a report to disk on the calling thread, outside the session budget, for a process
    /// that may stop before the background thread runs again, such as one that is panicking.
    pub(crate) fn store_now(&self, bytes: &[u8]) {
        if !self.shared.store.enabled() {
            return;
        }
        self.shared.store.persist(&[bytes.to_vec()]);
        self.wake();
    }

    /// Asks the background thread to upload what is waiting, after consent is granted.
    pub(crate) fn wake(&self) {
        let _ = self.shared.sender.try_send(Command::Wake);
    }

    /// Deletes everything waiting, after consent is withdrawn. The background thread repeats the
    /// deletion once it reaches the request, catching a report it was writing meanwhile, and
    /// discards reports still queued in memory.
    pub(crate) fn purge(&self) {
        self.shared.store.purge();
        let _ = self.shared.sender.try_send(Command::Purge);
    }

    /// Waits until every report handed over so far is on disk. Uploads are not awaited, since
    /// the service may be unreachable for days. A panicking thread has already written its report
    /// itself, so it does not wait behind an upload in progress.
    pub(crate) fn flush(&self, timeout: Duration) -> bool {
        if std::thread::panicking()
            || self.shared.worker.get() == Some(&std::thread::current().id())
        {
            return true;
        }
        let (ack, done) = mpsc::sync_channel(1);
        if self.shared.sender.try_send(Command::Flush(ack)).is_err() {
            return false;
        }
        done.recv_timeout(timeout).is_ok()
    }
}

/// The background thread: persists reports and uploads the queue with backoff.
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
                Ok(Command::Store(_)) if !self.store.enabled() => continue,
                Ok(Command::Store(reports)) => {
                    self.store.persist(&reports);
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
        if !self.store.enabled() {
            return None;
        }
        self.next_attempt
            .map(|at| at.saturating_duration_since(Instant::now()))
    }

    /// Uploads queued reports oldest first, stopping at the first failure and scheduling a
    /// retry with exponential backoff.
    fn upload_pending(&mut self) {
        for path in self.store.pending() {
            if !self.store.enabled() {
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

    /// Sends one report file and returns what the service said about it.
    fn upload(&mut self, path: &Path) -> UploadOutcome {
        let Ok(body) = std::fs::read(path) else {
            return UploadOutcome::Rejected;
        };
        let Endpoint {
            url,
            headers,
            content_type,
        } = self.endpoint.clone();
        let Some((runtime, client)) = self.http() else {
            return UploadOutcome::Unavailable;
        };
        let request = headers
            .into_iter()
            .fold(client.post(url), |request, (name, value)| {
                request.header(name, value)
            })
            .header(header::CONTENT_TYPE, content_type)
            .body(body);
        match runtime.block_on(async { request.send().await }) {
            Ok(response) => {
                let retry_after = response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok());
                let outcome = classify(response.status(), retry_after);
                tracing::debug!(status = %response.status(), ?outcome, "Uploaded a report");
                outcome
            }
            Err(error) => {
                tracing::debug!(%error, "Could not reach the report service");
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

    /// Sharing choice for stores that only write and list files.
    static SHARED: AtomicBool = AtomicBool::new(true);
    /// Limits used by the tests.
    const LIMITS: OutboxLimits = OutboxLimits {
        max_files: 50,
        max_bytes: 1024 * 1024,
        max_per_session: 10,
    };

    /// Queued reports come back oldest first and survive until uploaded or purged.
    #[test]
    fn store_lists_reports_oldest_first() {
        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().join("outbox"), &SHARED, LIMITS);
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

    /// A long offline stretch keeps only the newest reports within the count limit.
    #[test]
    fn store_drops_oldest_beyond_the_limit() {
        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().to_path_buf(), &SHARED, LIMITS);
        for index in 0..LIMITS.max_files + 5 {
            store.write(format!("{index:04}").as_bytes()).unwrap();
        }
        let pending = store.pending();
        assert_eq!(pending.len(), LIMITS.max_files);
        let oldest = std::fs::read_to_string(&pending[0]).unwrap();
        assert!(oldest.as_str() >= "0005", "kept {oldest}");
    }

    /// Oversized reports are never written.
    #[test]
    fn store_skips_oversized_reports() {
        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().to_path_buf(), &SHARED, LIMITS);
        store.write(&vec![0; MAX_REPORT_BYTES + 1]).unwrap();
        assert!(store.pending().is_empty());
    }

    /// Reports left on disk by an earlier session are uploaded with the service's headers once
    /// sharing is on, and deleted after the service accepts them; nothing is queued while off.
    #[test]
    fn uploads_queued_reports_once_enabled() {
        static ENABLED: AtomicBool = AtomicBool::new(false);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (received, uploads) = mpsc::channel();
        let app = axum::Router::new().route(
            "/track",
            axum::routing::post(move |headers: axum::http::HeaderMap, body: String| {
                let header = |name: &str| {
                    headers
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned)
                };
                received
                    .send((header("x-client"), header("content-type"), body))
                    .unwrap();
                async { StatusCode::OK }
            }),
        );
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let address = listener.local_addr().unwrap();
        runtime.spawn(async move { axum::serve(listener, app).await });

        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().to_path_buf(), &ENABLED, LIMITS);
        store.write(b"queued while offline").unwrap();
        let outbox = Outbox::start(
            store.clone(),
            Endpoint {
                url: format!("http://{address}/track"),
                headers: vec![("x-client", "test".into())],
                content_type: "application/json",
            },
            "test-outbox",
        )
        .unwrap();
        assert!(!outbox.queue(vec![b"captured while off".to_vec()]));
        assert!(outbox.flush(Duration::from_secs(5)));
        assert_eq!(store.pending().len(), 1);

        ENABLED.store(true, Ordering::Relaxed);
        outbox.wake();
        let upload = uploads.recv_timeout(Duration::from_secs(10));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !store.pending().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        ENABLED.store(false, Ordering::Relaxed);
        assert_eq!(
            upload.unwrap(),
            (
                Some("test".to_owned()),
                Some("application/json".to_owned()),
                "queued while offline".to_owned()
            )
        );
        assert!(store.pending().is_empty());
    }

    /// Batches are kept or dropped whole, and only while they fit the session budget.
    #[test]
    fn queues_whole_batches_within_the_budget() {
        static ENABLED: AtomicBool = AtomicBool::new(true);
        let directory = tempfile::tempdir().unwrap();
        let store = OutboxStore::new(directory.path().to_path_buf(), &ENABLED, LIMITS);
        let outbox = Outbox::start(
            store.clone(),
            Endpoint {
                url: "http://127.0.0.1:9/unreachable".into(),
                headers: Vec::new(),
                content_type: "application/json",
            },
            "budget-outbox",
        )
        .unwrap();
        assert!(outbox.queue(vec![b"a".to_vec(); 6]));
        assert!(!outbox.queue(vec![b"b".to_vec(); 5]));
        assert!(outbox.queue(vec![b"c".to_vec(); 4]));
        assert!(outbox.flush(Duration::from_secs(5)));
        assert_eq!(store.pending().len(), 10);
        ENABLED.store(false, Ordering::Relaxed);
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
