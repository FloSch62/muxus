//! One SSH channel as JavaScript sees it: a session (shell, command, subsystem), a tunnel to a
//! TCP target, or a connection the server opened towards us.
//!
//! A task per channel takes what the server sends and queues it for the reader. The queue is
//! bounded in bytes: russh grants the server more window as soon as data arrives, whether or not
//! anyone has read it, so the only brake is to stop taking messages from the session. A reader
//! that stays behind therefore slows the whole connection once its queue is full.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Sig};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Semaphore, mpsc, oneshot};

use crate::error::{coded, disconnected, from_russh};
use crate::local::LocalStream;

/// Bytes a channel holds for a reader that has fallen behind.
const QUEUE_BYTES: usize = 4 * 1024 * 1024;
/// Most that one `read` hands to JavaScript.
const READ_BYTES: usize = 256 * 1024;
/// A tunnel whose local end takes nothing for this long is closed: it would otherwise hold up
/// every other channel of the connection.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

enum Item {
    Data(Bytes),
    Stderr(Bytes),
    Eof,
    Exit {
        code: Option<u32>,
        signal: Option<String>,
    },
}

/// What the server sent on a channel, in order. `kind` is `data`, `stderr`, `eof`, `exit` or
/// `close`; after `close` nothing else follows.
#[napi(object)]
pub struct ChannelEvent {
    pub kind: String,
    pub data: Option<Buffer>,
    pub code: Option<u32>,
    pub signal: Option<String>,
}

impl ChannelEvent {
    fn bare(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            data: None,
            code: None,
            signal: None,
        }
    }

    fn bytes(kind: &str, data: Vec<u8>) -> Self {
        Self {
            data: Some(Buffer::from(data)),
            ..Self::bare(kind)
        }
    }
}

/// Replies to channel requests arrive in the order the requests were sent.
#[derive(Default)]
struct Replies {
    waiting: Mutex<VecDeque<oneshot::Sender<bool>>>,
}

impl Replies {
    fn expect(&self) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        lock(&self.waiting).push_back(tx);
        rx
    }

    fn answer(&self, accepted: bool) {
        if let Some(tx) = lock(&self.waiting).pop_front() {
            let _ = tx.send(accepted);
        }
    }

    fn abandon(&self) {
        lock(&self.waiting).clear();
    }
}

struct Incoming {
    items: mpsc::UnboundedReceiver<Item>,
    /// An item taken while gathering a read that belongs to the next one.
    held: Option<Item>,
}

pub(crate) struct ChannelCore {
    write: ChannelWriteHalf<Msg>,
    replies: Replies,
    /// Serializes requests so their replies pair up.
    requests: tokio::sync::Mutex<()>,
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    incoming: tokio::sync::Mutex<Option<Incoming>>,
    budget: Arc<Semaphore>,
    closed: AtomicBool,
    x11_forwarded: AtomicBool,
}

impl ChannelCore {
    pub(crate) fn start(channel: Channel<Msg>) -> Arc<Self> {
        let (read, write) = channel.split();
        let (tx, rx) = mpsc::unbounded_channel();
        let budget = Arc::new(Semaphore::new(QUEUE_BYTES));
        let writer: Box<dyn AsyncWrite + Send + Unpin> = Box::new(Box::pin(write.make_writer()));
        let core = Arc::new(Self {
            write,
            replies: Replies::default(),
            requests: tokio::sync::Mutex::new(()),
            writer: tokio::sync::Mutex::new(writer),
            incoming: tokio::sync::Mutex::new(Some(Incoming {
                items: rx,
                held: None,
            })),
            budget: budget.clone(),
            closed: AtomicBool::new(false),
            x11_forwarded: AtomicBool::new(false),
        });
        tokio::spawn(receive(read, tx, budget, core.clone()));
        core
    }

    /// Send a request that asks for a reply and wait for it.
    async fn request<F, Fut>(&self, send: F) -> Result<bool>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = std::result::Result<(), russh::Error>>,
    {
        let reply = {
            let _order = self.requests.lock().await;
            let reply = self.replies.expect();
            send().await.map_err(from_russh)?;
            reply
        };
        reply.await.map_err(|_| disconnected())
    }

    pub(crate) fn mark_x11_forwarded(&self) {
        self.x11_forwarded.store(true, Ordering::Release);
    }

    pub(crate) async fn request_x11(
        &self,
        single: bool,
        protocol: &str,
        cookie: &str,
        screen: u32,
    ) -> Result<bool> {
        self.request(|| {
            self.write
                .request_x11(true, single, protocol, cookie, screen)
        })
        .await
    }

    pub(crate) async fn request_agent_forwarding(&self) -> Result<()> {
        // Like ssh(1), without asking for a reply: a server that refuses costs the forwarding,
        // not the session.
        self.write.agent_forward(false).await.map_err(from_russh)
    }

    pub(crate) async fn request_pty(
        &self,
        term: &str,
        cols: u32,
        rows: u32,
        width: u32,
        height: u32,
        modes: &[(russh::Pty, u32)],
    ) -> Result<bool> {
        self.request(|| {
            self.write
                .request_pty(true, term, cols, rows, width, height, modes)
        })
        .await
    }

    pub(crate) async fn set_env(&self, name: &str, value: &str) -> Result<()> {
        self.write
            .set_env(false, name, value)
            .await
            .map_err(from_russh)
    }

    pub(crate) async fn request_shell(&self) -> Result<bool> {
        self.request(|| self.write.request_shell(true)).await
    }

    pub(crate) async fn request_exec(&self, command: &str) -> Result<bool> {
        self.request(|| self.write.exec(true, command.as_bytes().to_vec()))
            .await
    }

    pub(crate) async fn request_subsystem(&self, name: &str) -> Result<bool> {
        self.request(|| self.write.request_subsystem(true, name))
            .await
    }

    pub(crate) async fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            let _ = self.write.close().await;
        }
        // Nobody reads this channel any more. Whatever the server still sends before it sees
        // the close must not wait on the reader, or it would hold up the whole connection.
        self.budget.close();
    }

    async fn next(&self, incoming: &mut Incoming) -> Option<Item> {
        let item = match incoming.held.take() {
            Some(item) => Some(item),
            None => incoming.items.recv().await,
        };
        if let Some(Item::Data(data) | Item::Stderr(data)) = &item {
            self.budget.add_permits(data.len());
        }
        item
    }
}

impl Drop for ChannelCore {
    fn drop(&mut self) {
        // The wrapper was collected without a close: tell the server, so it frees the channel.
        self.replies.abandon();
    }
}

/// Take what the server sends until the channel closes or the session ends.
async fn receive(
    mut read: ChannelReadHalf,
    tx: mpsc::UnboundedSender<Item>,
    budget: Arc<Semaphore>,
    core: Arc<ChannelCore>,
) {
    // The task must not keep the channel alive once JavaScript has let go of it.
    let core = Arc::downgrade(&core);
    loop {
        let message = read.wait().await;
        let Some(core) = core.upgrade() else { break };
        let item = match message {
            Some(ChannelMsg::Data { data }) => Item::Data(data),
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => Item::Stderr(data),
            Some(ChannelMsg::Eof) => Item::Eof,
            Some(ChannelMsg::ExitStatus { exit_status }) => Item::Exit {
                code: Some(exit_status),
                signal: None,
            },
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => Item::Exit {
                code: None,
                signal: Some(signal_name_text(&signal_name)),
            },
            Some(ChannelMsg::Success) => {
                core.replies.answer(true);
                continue;
            }
            Some(ChannelMsg::Failure) => {
                core.replies.answer(false);
                continue;
            }
            Some(ChannelMsg::Close) | None => {
                core.closed.store(true, Ordering::Release);
                core.replies.abandon();
                break;
            }
            Some(_) => continue,
        };
        let abandoned = core.closed.load(Ordering::Acquire);
        drop(core);
        if abandoned {
            // Closed from our side: the rest is only read to reach the server's own close.
            continue;
        }
        if let Item::Data(data) | Item::Stderr(data) = &item {
            // Waits here while the reader is behind by a full queue.
            match budget
                .acquire_many(data.len().min(QUEUE_BYTES) as u32)
                .await
            {
                Ok(permit) => permit.forget(),
                // Closed while waiting for room.
                Err(_) => continue,
            }
        }
        if tx.send(item).is_err() {
            break;
        }
    }
}

fn signal_name_text(signal: &Sig) -> String {
    match signal {
        Sig::ABRT => "ABRT",
        Sig::ALRM => "ALRM",
        Sig::FPE => "FPE",
        Sig::HUP => "HUP",
        Sig::ILL => "ILL",
        Sig::INT => "INT",
        Sig::KILL => "KILL",
        Sig::PIPE => "PIPE",
        Sig::QUIT => "QUIT",
        Sig::SEGV => "SEGV",
        Sig::TERM => "TERM",
        Sig::USR1 => "USR1",
        Sig::Custom(name) => name,
    }
    .to_string()
}

fn signal_from_name(name: &str) -> Sig {
    match name.trim_start_matches("SIG") {
        "ABRT" => Sig::ABRT,
        "ALRM" => Sig::ALRM,
        "FPE" => Sig::FPE,
        "HUP" => Sig::HUP,
        "ILL" => Sig::ILL,
        "INT" => Sig::INT,
        "KILL" => Sig::KILL,
        "PIPE" => Sig::PIPE,
        "QUIT" => Sig::QUIT,
        "SEGV" => Sig::SEGV,
        "TERM" => Sig::TERM,
        "USR1" => Sig::USR1,
        other => Sig::Custom(other.to_string()),
    }
}

/// An open SSH channel.
#[napi]
pub struct SshChannel {
    pub(crate) core: Arc<ChannelCore>,
}

impl SshChannel {
    pub(crate) fn new(core: Arc<ChannelCore>) -> Self {
        Self { core }
    }
}

impl Drop for SshChannel {
    fn drop(&mut self) {
        // Collected without a close: tell the server, so it frees the channel.
        if !self.core.closed.load(Ordering::Acquire) {
            let core = self.core.clone();
            crate::rt::spawn(async move { core.close().await });
        }
    }
}

#[napi]
impl SshChannel {
    /// Whether the server accepted X11 forwarding for this session.
    #[napi(getter)]
    pub fn x11_forwarded(&self) -> bool {
        self.core.x11_forwarded.load(Ordering::Acquire)
    }

    /// The next thing the server sent. Output that arrived together comes back as one buffer.
    #[napi]
    pub async fn read(&self) -> Result<ChannelEvent> {
        let mut guard = self.core.incoming.lock().await;
        let Some(incoming) = guard.as_mut() else {
            return Err(coded(
                "CHANNEL_SPLICED",
                "the channel was handed to a local stream",
            ));
        };
        let Some(first) = self.core.next(incoming).await else {
            return Ok(ChannelEvent::bare("close"));
        };
        match first {
            Item::Eof => Ok(ChannelEvent::bare("eof")),
            Item::Exit { code, signal } => Ok(ChannelEvent {
                code,
                signal,
                ..ChannelEvent::bare("exit")
            }),
            Item::Data(data) => Ok(ChannelEvent::bytes(
                "data",
                self.gather(incoming, data, false),
            )),
            Item::Stderr(data) => Ok(ChannelEvent::bytes(
                "stderr",
                self.gather(incoming, data, true),
            )),
        }
    }

    /// Send bytes to the remote end. Settles once the channel window has taken them.
    #[napi]
    pub async fn write(&self, data: Buffer) -> Result<()> {
        let mut writer = self.core.writer.lock().await;
        writer
            .write_all(&data)
            .await
            .map_err(|_| coded("CHANNEL_CLOSED", "the channel is closed"))
    }

    /// No more input follows; the remote end may still send.
    #[napi]
    pub async fn eof(&self) -> Result<()> {
        // After everything written so far.
        let _writer = self.core.writer.lock().await;
        self.core.write.eof().await.map_err(from_russh)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.core.close().await;
        Ok(())
    }

    /// Tell the remote terminal its new size.
    #[napi]
    pub async fn resize(&self, cols: u32, rows: u32, width: u32, height: u32) -> Result<()> {
        self.core
            .write
            .window_change(cols, rows, width, height)
            .await
            .map_err(from_russh)
    }

    /// Deliver a signal by name (`TERM`, `INT`, ...) to the remote process.
    #[napi]
    pub async fn signal(&self, name: String) -> Result<()> {
        self.core
            .write
            .signal(signal_from_name(&name))
            .await
            .map_err(from_russh)
    }

    /// Join the channel to a local stream until either side ends. `head` goes to the local side
    /// first. Bytes then never pass through JavaScript.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn splice<'env>(
        &self,
        env: &'env Env,
        local: &LocalStream,
        head: Option<Buffer>,
    ) -> Result<PromiseRaw<'env, ()>> {
        let core = self.core.clone();
        let stream = local.take()?;
        let head = head.map(|h| h.to_vec());
        env.spawn_future(async move {
            let Some(incoming) = core.incoming.lock().await.take() else {
                return Err(coded(
                    "CHANNEL_SPLICED",
                    "the channel was handed to a local stream",
                ));
            };
            splice(core, incoming, stream, head).await;
            Ok(())
        })
    }
}

impl SshChannel {
    /// Append the output that already waits behind `first`, up to one read's worth.
    fn gather(&self, incoming: &mut Incoming, first: Bytes, stderr: bool) -> Vec<u8> {
        let mut out = BytesMut::from(first.as_ref());
        while out.len() < READ_BYTES {
            match incoming.items.try_recv() {
                Ok(Item::Data(more)) if !stderr => {
                    self.core.budget.add_permits(more.len());
                    out.extend_from_slice(&more);
                }
                Ok(Item::Stderr(more)) if stderr => {
                    self.core.budget.add_permits(more.len());
                    out.extend_from_slice(&more);
                }
                Ok(other) => {
                    incoming.held = Some(other);
                    break;
                }
                Err(_) => break,
            }
        }
        out.to_vec()
    }
}

/// Carry bytes between a channel that already has a reader task and a local stream.
async fn splice(
    core: Arc<ChannelCore>,
    mut incoming: Incoming,
    stream: crate::stream::BoxedStream,
    head: Option<Vec<u8>>,
) {
    let (mut local_read, mut local_write) = tokio::io::split(stream);
    let to_local = async {
        if let Some(head) = head {
            write_or_stall(&mut local_write, &head).await?;
        }
        while let Some(item) = core.next(&mut incoming).await {
            match item {
                Item::Data(data) => write_or_stall(&mut local_write, &data).await?,
                Item::Eof => {
                    let _ = local_write.shutdown().await;
                }
                Item::Stderr(_) | Item::Exit { .. } => {}
            }
        }
        Ok::<(), std::io::Error>(())
    };
    let to_remote = async {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            let read = local_read.read(&mut buffer).await?;
            if read == 0 {
                let _writer = core.writer.lock().await;
                let _ = core.write.eof().await;
                return Ok::<(), std::io::Error>(());
            }
            core.writer.lock().await.write_all(&buffer[..read]).await?;
        }
    };
    run_both(to_local, to_remote).await;
    core.close().await;
}

async fn write_or_stall<W: AsyncWrite + Unpin>(writer: &mut W, data: &[u8]) -> std::io::Result<()> {
    match tokio::time::timeout(STALL_TIMEOUT, writer.write_all(data)).await {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "the local end stopped reading",
        )),
    }
}

/// Run both directions of a tunnel. The remote side ending, or either side failing, ends it;
/// the local side merely finishing leaves the remote side to send what it still has.
async fn run_both(
    to_local: impl Future<Output = std::io::Result<()>>,
    to_remote: impl Future<Output = std::io::Result<()>>,
) {
    tokio::pin!(to_local, to_remote);
    let mut local_finished = false;
    loop {
        tokio::select! {
            _ = &mut to_local => break,
            result = &mut to_remote, if !local_finished => {
                if result.is_err() {
                    break;
                }
                local_finished = true;
            }
        }
    }
}

/// Carry bytes between a fresh channel and a local stream, as a port forward does.
pub(crate) async fn tunnel<S>(channel: Channel<Msg>, stream: S, head: Option<Vec<u8>>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut remote_read, remote_write) = channel.split();
    let (mut local_read, mut local_write) = tokio::io::split(stream);
    let to_local = async {
        loop {
            match remote_read.wait().await {
                Some(ChannelMsg::Data { data }) => write_or_stall(&mut local_write, &data).await?,
                Some(ChannelMsg::Eof) => {
                    let _ = local_write.shutdown().await;
                }
                Some(ChannelMsg::Close) | None => return Ok::<(), std::io::Error>(()),
                Some(_) => {}
            }
        }
    };
    let to_remote = async {
        let mut writer = Box::pin(remote_write.make_writer());
        if let Some(head) = head {
            writer.write_all(&head).await?;
        }
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            let read = local_read.read(&mut buffer).await?;
            if read == 0 {
                let _ = remote_write.eof().await;
                return Ok::<(), std::io::Error>(());
            }
            writer.write_all(&buffer[..read]).await?;
        }
    };
    run_both(to_local, to_remote).await;
    let _ = remote_write.close().await;
}
