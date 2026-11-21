//! An SFTP (version 3) client over any byte stream: a channel of an SSH connection, or the
//! standard streams of a program such as `ssh -s sftp`.
//!
//! Handles are kept as the bytes the server sent, never as text. Requests are answered by id,
//! so reads and writes of a transfer are sent ahead of their replies; a session that ends fails
//! everything still waiting on it at once.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

use crate::channel::lock;
use crate::client::EnvVar;
use crate::error::{coded, coded_detail};

const INIT: u8 = 1;
const VERSION: u8 = 2;
const OPEN: u8 = 3;
const CLOSE: u8 = 4;
const READ: u8 = 5;
const WRITE: u8 = 6;
const LSTAT: u8 = 7;
const FSTAT: u8 = 8;
const SETSTAT: u8 = 9;
const FSETSTAT: u8 = 10;
const OPENDIR: u8 = 11;
const READDIR: u8 = 12;
const REMOVE: u8 = 13;
const MKDIR: u8 = 14;
const RMDIR: u8 = 15;
const REALPATH: u8 = 16;
const STAT: u8 = 17;
const RENAME: u8 = 18;
const READLINK: u8 = 19;
const EXTENDED: u8 = 200;
const STATUS: u8 = 101;
const HANDLE: u8 = 102;
const DATA: u8 = 103;
const NAME: u8 = 104;
const ATTRS: u8 = 105;
const EXTENDED_REPLY: u8 = 201;

const STATUS_OK: u32 = 0;
const STATUS_EOF: u32 = 1;

const ATTR_SIZE: u32 = 0x1;
const ATTR_UIDGID: u32 = 0x2;
const ATTR_PERMISSIONS: u32 = 0x4;
const ATTR_ACMODTIME: u32 = 0x8;
const ATTR_EXTENDED: u32 = 0x8000_0000;

/// Every server takes requests of this size; larger ones are a matter of negotiation.
const CHUNK: u32 = 32 * 1024;
/// Reads and writes of one transfer that may be waiting for their replies.
const PIPELINE: usize = 64;
/// Most that one `read` of a transfer hands to JavaScript.
const READ_BYTES: usize = 256 * 1024;
/// Replies are small except for file data and listings; this only bounds a confused peer.
const MAX_PACKET: usize = 32 * 1024 * 1024;
const POSIX_RENAME: &str = "posix-rename@openssh.com";

type CloseFn = ThreadsafeFunction<(), (), (), Status, false, true>;

/// File attributes; a field the server did not send is absent.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct SftpAttrs {
    pub size: Option<f64>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    /// Type and permission bits, as in `st_mode`.
    pub mode: Option<u32>,
    pub atime: Option<u32>,
    pub mtime: Option<u32>,
}

#[napi(object)]
pub struct SftpEntry {
    pub name: String,
    /// The server's `ls -l` line for the entry.
    pub longname: String,
    pub attrs: SftpAttrs,
}

enum Reply {
    Status { code: u32, message: String },
    Handle(Vec<u8>),
    Data(Vec<u8>),
    Name(Vec<SftpEntry>),
    Attrs(SftpAttrs),
    Extended,
}

struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    fn u32(&mut self) -> Option<u32> {
        let (head, rest) = self.rest.split_at_checked(4)?;
        self.rest = rest;
        Some(u32::from_be_bytes(head.try_into().ok()?))
    }

    fn u64(&mut self) -> Option<u64> {
        let (head, rest) = self.rest.split_at_checked(8)?;
        self.rest = rest;
        Some(u64::from_be_bytes(head.try_into().ok()?))
    }

    fn string(&mut self) -> Option<&'a [u8]> {
        let length = self.u32()? as usize;
        let (head, rest) = self.rest.split_at_checked(length)?;
        self.rest = rest;
        Some(head)
    }

    fn text(&mut self) -> Option<String> {
        Some(String::from_utf8_lossy(self.string()?).into_owned())
    }

    fn attrs(&mut self) -> Option<SftpAttrs> {
        let flags = self.u32()?;
        let mut attrs = SftpAttrs::default();
        if flags & ATTR_SIZE != 0 {
            attrs.size = Some(self.u64()? as f64);
        }
        if flags & ATTR_UIDGID != 0 {
            attrs.uid = Some(self.u32()?);
            attrs.gid = Some(self.u32()?);
        }
        if flags & ATTR_PERMISSIONS != 0 {
            attrs.mode = Some(self.u32()?);
        }
        if flags & ATTR_ACMODTIME != 0 {
            attrs.atime = Some(self.u32()?);
            attrs.mtime = Some(self.u32()?);
        }
        if flags & ATTR_EXTENDED != 0 {
            for _ in 0..self.u32()? {
                self.string()?;
                self.string()?;
            }
        }
        Some(attrs)
    }
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn put_string(out: &mut Vec<u8>, value: &[u8]) {
    put_u32(out, value.len() as u32);
    out.extend_from_slice(value);
}

fn put_attrs(out: &mut Vec<u8>, attrs: Option<&SftpAttrs>) {
    let Some(attrs) = attrs else {
        put_u32(out, 0);
        return;
    };
    let mut flags = 0;
    if attrs.size.is_some() {
        flags |= ATTR_SIZE;
    }
    if attrs.uid.is_some() && attrs.gid.is_some() {
        flags |= ATTR_UIDGID;
    }
    if attrs.mode.is_some() {
        flags |= ATTR_PERMISSIONS;
    }
    if attrs.atime.is_some() && attrs.mtime.is_some() {
        flags |= ATTR_ACMODTIME;
    }
    put_u32(out, flags);
    if let Some(size) = attrs.size {
        put_u64(out, size as u64);
    }
    if let (Some(uid), Some(gid)) = (attrs.uid, attrs.gid) {
        put_u32(out, uid);
        put_u32(out, gid);
    }
    if let Some(mode) = attrs.mode {
        put_u32(out, mode);
    }
    if let (Some(atime), Some(mtime)) = (attrs.atime, attrs.mtime) {
        put_u32(out, atime);
        put_u32(out, mtime);
    }
}

fn parse_reply(kind: u8, body: &[u8]) -> Option<Reply> {
    let mut reader = Reader { rest: body };
    Some(match kind {
        STATUS => {
            let code = reader.u32()?;
            // The oldest servers send the code alone.
            let message = reader.text().unwrap_or_default();
            Reply::Status { code, message }
        }
        HANDLE => Reply::Handle(reader.string()?.to_vec()),
        DATA => Reply::Data(reader.string()?.to_vec()),
        NAME => {
            let count = reader.u32()?;
            let mut entries = Vec::with_capacity(count.min(4096) as usize);
            for _ in 0..count {
                entries.push(SftpEntry {
                    name: reader.text()?,
                    longname: reader.text()?,
                    attrs: reader.attrs()?,
                });
            }
            Reply::Name(entries)
        }
        ATTRS => Reply::Attrs(reader.attrs()?),
        EXTENDED_REPLY => Reply::Extended,
        _ => return None,
    })
}

fn status_text(code: u32) -> &'static str {
    match code {
        1 => "End of file",
        2 => "No such file",
        3 => "Permission denied",
        4 => "Failure",
        5 => "Bad message",
        6 => "No connection",
        7 => "Connection lost",
        8 => "Operation unsupported",
        _ => "Unknown status",
    }
}

fn status_error(code: u32, message: &str) -> Error {
    let text = if message.is_empty() {
        status_text(code)
    } else {
        message
    };
    coded_detail("SFTP_STATUS", code, text)
}

fn session_ended() -> Error {
    coded("SFTP_CLOSED", "The SFTP session has ended.")
}

fn unexpected() -> Error {
    coded(
        "SFTP_PROTOCOL",
        "the server answered with a reply that does not fit the request",
    )
}

type Pending = Mutex<Option<HashMap<u32, oneshot::Sender<Reply>>>>;

pub(crate) struct SftpCore {
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    /// `None` once the session has ended: nothing can be asked any more.
    pending: Arc<Pending>,
    next_id: AtomicU32,
    extensions: Vec<String>,
    closed: Arc<watch::Sender<bool>>,
    /// The program whose standard streams carry the session, ended with it.
    child: Mutex<Option<tokio::process::Child>>,
}

impl SftpCore {
    /// Send a request and return the slot its reply lands in.
    fn send(&self, kind: u8, body: impl FnOnce(&mut Vec<u8>)) -> Result<oneshot::Receiver<Reply>> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut packet = vec![0u8; 4];
        packet.push(kind);
        put_u32(&mut packet, id);
        body(&mut packet);
        let length = (packet.len() - 4) as u32;
        packet[..4].copy_from_slice(&length.to_be_bytes());
        let (tx, rx) = oneshot::channel();
        match lock(&self.pending).as_mut() {
            Some(pending) => pending.insert(id, tx),
            None => return Err(session_ended()),
        };
        self.outgoing.send(packet).map_err(|_| session_ended())?;
        Ok(rx)
    }

    async fn request(&self, kind: u8, body: impl FnOnce(&mut Vec<u8>)) -> Result<Reply> {
        self.send(kind, body)?.await.map_err(|_| session_ended())
    }

    /// A request answered by a status alone.
    async fn command(&self, kind: u8, body: impl FnOnce(&mut Vec<u8>)) -> Result<()> {
        match self.request(kind, body).await? {
            Reply::Status {
                code: STATUS_OK, ..
            } => Ok(()),
            Reply::Status { code, message } => Err(status_error(code, &message)),
            _ => Err(unexpected()),
        }
    }

    async fn attrs(&self, kind: u8, target: &[u8]) -> Result<SftpAttrs> {
        match self.request(kind, |out| put_string(out, target)).await? {
            Reply::Attrs(attrs) => Ok(attrs),
            Reply::Status { code, message } => Err(status_error(code, &message)),
            _ => Err(unexpected()),
        }
    }

    async fn handle(&self, kind: u8, body: impl FnOnce(&mut Vec<u8>)) -> Result<Vec<u8>> {
        match self.request(kind, body).await? {
            Reply::Handle(handle) => Ok(handle),
            Reply::Status { code, message } => Err(status_error(code, &message)),
            _ => Err(unexpected()),
        }
    }

    async fn name(&self, kind: u8, path: &str) -> Result<Vec<SftpEntry>> {
        match self
            .request(kind, |out| put_string(out, path.as_bytes()))
            .await?
        {
            Reply::Name(entries) => Ok(entries),
            Reply::Status { code, message } => Err(status_error(code, &message)),
            _ => Err(unexpected()),
        }
    }

    fn shut(&self) {
        self.closed.send_replace(true);
        lock(&self.pending).take();
        if let Some(mut child) = lock(&self.child).take() {
            let _ = child.start_kill();
        }
    }
}

impl Drop for SftpCore {
    fn drop(&mut self) {
        self.shut();
    }
}

async fn read_packet<R: AsyncRead + Unpin>(stream: &mut R) -> std::io::Result<Vec<u8>> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_PACKET {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bad SFTP packet length",
        ));
    }
    let mut packet = vec![0u8; length];
    stream.read_exact(&mut packet).await?;
    Ok(packet)
}

/// An SFTP session.
#[napi]
pub struct SftpSession {
    core: Arc<SftpCore>,
}

impl SftpSession {
    /// Greet the server over `stream` and start serving requests.
    pub(crate) async fn start<S>(
        stream: S,
        child: Option<tokio::process::Child>,
    ) -> Result<SftpSession>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (mut read, mut write) = tokio::io::split(stream);
        let mut init = Vec::new();
        put_u32(&mut init, 5);
        init.push(INIT);
        put_u32(&mut init, 3);
        let ended = |_| coded("SFTP_CLOSED", "The SFTP session ended before it was ready.");
        write.write_all(&init).await.map_err(ended)?;
        write.flush().await.map_err(ended)?;
        let greeting = read_packet(&mut read).await.map_err(ended)?;
        let mut reader = Reader {
            rest: greeting.get(1..).unwrap_or_default(),
        };
        if greeting.first() != Some(&VERSION) || reader.u32().is_none_or(|version| version < 3) {
            return Err(coded(
                "SFTP_PROTOCOL",
                "the server speaks no SFTP version 3",
            ));
        }
        let mut extensions = Vec::new();
        while let Some(name) = reader.text() {
            reader.string();
            extensions.push(name);
        }

        let (outgoing, mut queue) = mpsc::unbounded_channel::<Vec<u8>>();
        let pending: Arc<Pending> = Arc::new(Mutex::new(Some(HashMap::new())));
        let closed = Arc::new(watch::channel(false).0);
        tokio::spawn(async move {
            while let Some(packet) = queue.recv().await {
                if write.write_all(&packet).await.is_err() || write.flush().await.is_err() {
                    break;
                }
            }
            let _ = write.shutdown().await;
        });
        let replies = pending.clone();
        let ended = closed.clone();
        tokio::spawn(async move {
            while let Ok(packet) = read_packet(&mut read).await {
                let Some((&kind, rest)) = packet.split_first() else {
                    break;
                };
                let Some(id) = rest
                    .get(..4)
                    .map(|id| u32::from_be_bytes([id[0], id[1], id[2], id[3]]))
                else {
                    break;
                };
                let Some(reply) = parse_reply(kind, &rest[4..]) else {
                    break;
                };
                let waiter = lock(&replies)
                    .as_mut()
                    .and_then(|pending| pending.remove(&id));
                if let Some(waiter) = waiter {
                    let _ = waiter.send(reply);
                }
            }
            // Dropping the waiters fails every request still out.
            lock(&replies).take();
            ended.send_replace(true);
        });
        Ok(SftpSession {
            core: Arc::new(SftpCore {
                outgoing,
                pending,
                next_id: AtomicU32::new(1),
                extensions,
                closed,
                child: Mutex::new(child),
            }),
        })
    }
}

#[napi]
impl SftpSession {
    #[napi(getter)]
    pub fn closed(&self) -> bool {
        *self.core.closed.borrow()
    }

    /// Whether the server announced an extension, such as `posix-rename@openssh.com`.
    #[napi]
    pub fn has_extension(&self, name: String) -> bool {
        self.core.extensions.contains(&name)
    }

    /// End the session, and the program that carries it when there is one.
    #[napi]
    pub fn close(&self) {
        self.core.shut();
        // An empty write wakes the writer task, which then finds its queue closed.
        let _ = self.core.outgoing.send(Vec::new());
    }

    /// Call `listener` once when the session ends.
    #[napi(ts_args_type = "listener: () => void")]
    pub fn on_close(&self, listener: CloseFn) {
        let mut closed = self.core.closed.subscribe();
        crate::rt::spawn(async move {
            let _ = closed.wait_for(|closed| *closed).await;
            listener.call((), ThreadsafeFunctionCallMode::NonBlocking);
        });
    }

    #[napi]
    pub async fn realpath(&self, path: String) -> Result<String> {
        self.core
            .name(REALPATH, &path)
            .await?
            .into_iter()
            .next()
            .map(|entry| entry.name)
            .ok_or_else(unexpected)
    }

    #[napi]
    pub async fn readlink(&self, path: String) -> Result<String> {
        self.core
            .name(READLINK, &path)
            .await?
            .into_iter()
            .next()
            .map(|entry| entry.name)
            .ok_or_else(unexpected)
    }

    #[napi]
    pub async fn stat(&self, path: String) -> Result<SftpAttrs> {
        self.core.attrs(STAT, path.as_bytes()).await
    }

    #[napi]
    pub async fn lstat(&self, path: String) -> Result<SftpAttrs> {
        self.core.attrs(LSTAT, path.as_bytes()).await
    }

    #[napi]
    pub async fn fstat(&self, handle: Buffer) -> Result<SftpAttrs> {
        self.core.attrs(FSTAT, &handle).await
    }

    #[napi]
    pub async fn setstat(&self, path: String, attrs: SftpAttrs) -> Result<()> {
        self.core
            .command(SETSTAT, |out| {
                put_string(out, path.as_bytes());
                put_attrs(out, Some(&attrs));
            })
            .await
    }

    #[napi]
    pub async fn fsetstat(&self, handle: Buffer, attrs: SftpAttrs) -> Result<()> {
        self.core
            .command(FSETSTAT, |out| {
                put_string(out, &handle);
                put_attrs(out, Some(&attrs));
            })
            .await
    }

    /// Open a file. `flags` are the protocol's: 1 read, 2 write, 4 append, 8 create,
    /// 16 truncate, 32 exclusive.
    #[napi]
    pub async fn open(&self, path: String, flags: u32, attrs: Option<SftpAttrs>) -> Result<Buffer> {
        self.core
            .handle(OPEN, |out| {
                put_string(out, path.as_bytes());
                put_u32(out, flags);
                put_attrs(out, attrs.as_ref());
            })
            .await
            .map(Buffer::from)
    }

    #[napi]
    pub async fn close_handle(&self, handle: Buffer) -> Result<()> {
        self.core
            .command(CLOSE, |out| put_string(out, &handle))
            .await
    }

    /// Up to `length` bytes at `offset`, or null at the end of the file.
    #[napi]
    pub async fn read(&self, handle: Buffer, offset: f64, length: u32) -> Result<Option<Buffer>> {
        let reply = self
            .core
            .request(READ, |out| {
                put_string(out, &handle);
                put_u64(out, offset as u64);
                put_u32(out, length.min(CHUNK));
            })
            .await?;
        match reply {
            Reply::Data(data) => Ok(Some(Buffer::from(data))),
            Reply::Status {
                code: STATUS_EOF, ..
            } => Ok(None),
            Reply::Status { code, message } => Err(status_error(code, &message)),
            _ => Err(unexpected()),
        }
    }

    #[napi]
    pub async fn mkdir(&self, path: String, attrs: Option<SftpAttrs>) -> Result<()> {
        self.core
            .command(MKDIR, |out| {
                put_string(out, path.as_bytes());
                put_attrs(out, attrs.as_ref());
            })
            .await
    }

    #[napi]
    pub async fn rmdir(&self, path: String) -> Result<()> {
        self.core
            .command(RMDIR, |out| put_string(out, path.as_bytes()))
            .await
    }

    #[napi]
    pub async fn remove(&self, path: String) -> Result<()> {
        self.core
            .command(REMOVE, |out| put_string(out, path.as_bytes()))
            .await
    }

    /// The protocol's own rename, which most servers refuse onto an existing name.
    #[napi]
    pub async fn rename(&self, from: String, to: String) -> Result<()> {
        self.core
            .command(RENAME, |out| {
                put_string(out, from.as_bytes());
                put_string(out, to.as_bytes());
            })
            .await
    }

    /// OpenSSH's atomic rename over an existing name. Fails with `SFTP_UNSUPPORTED` on a server
    /// that did not announce it.
    #[napi]
    pub async fn posix_rename(&self, from: String, to: String) -> Result<()> {
        if !self.core.extensions.iter().any(|name| name == POSIX_RENAME) {
            return Err(coded(
                "SFTP_UNSUPPORTED",
                "Server does not support this extended request",
            ));
        }
        self.core
            .command(EXTENDED, |out| {
                put_string(out, POSIX_RENAME.as_bytes());
                put_string(out, from.as_bytes());
                put_string(out, to.as_bytes());
            })
            .await
    }

    /// Every entry of a directory, `.` and `..` included when the server lists them.
    #[napi]
    pub async fn readdir(&self, path: String) -> Result<Vec<SftpEntry>> {
        let core = &self.core;
        let handle = core
            .handle(OPENDIR, |out| put_string(out, path.as_bytes()))
            .await?;
        let mut entries = Vec::new();
        let listing = async {
            loop {
                match core
                    .request(READDIR, |out| put_string(out, &handle))
                    .await?
                {
                    Reply::Name(mut batch) => entries.append(&mut batch),
                    Reply::Status {
                        code: STATUS_EOF, ..
                    } => return Ok(()),
                    Reply::Status { code, message } => return Err(status_error(code, &message)),
                    _ => return Err(unexpected()),
                }
            }
        }
        .await;
        let _ = core.command(CLOSE, |out| put_string(out, &handle)).await;
        listing.map(|()| entries)
    }

    /// Read an open file from `start` on, with the reads sent ahead of their replies.
    #[napi]
    pub fn reader(&self, handle: Buffer, start: f64) -> SftpReader {
        SftpReader {
            state: tokio::sync::Mutex::new(ReadState {
                core: self.core.clone(),
                handle: handle.to_vec(),
                next: start as u64,
                waiting: VecDeque::new(),
                depth: 2,
                ended: false,
            }),
        }
    }

    /// Write an open file from `start` on, with the writes sent ahead of their replies.
    #[napi]
    pub fn writer(&self, handle: Buffer, start: f64) -> SftpWriter {
        SftpWriter {
            state: tokio::sync::Mutex::new(WriteState {
                core: self.core.clone(),
                handle: handle.to_vec(),
                next: start as u64,
                waiting: VecDeque::new(),
            }),
        }
    }
}

struct PendingRead {
    offset: u64,
    length: u32,
    reply: oneshot::Receiver<Reply>,
}

struct ReadState {
    core: Arc<SftpCore>,
    handle: Vec<u8>,
    next: u64,
    waiting: VecDeque<PendingRead>,
    /// Reads kept out at once; grows as the file turns out to be long.
    depth: usize,
    ended: bool,
}

impl ReadState {
    fn ask(&self, offset: u64, length: u32) -> Result<PendingRead> {
        let reply = self.core.send(READ, |out| {
            put_string(out, &self.handle);
            put_u64(out, offset);
            put_u32(out, length);
        })?;
        Ok(PendingRead {
            offset,
            length,
            reply,
        })
    }

    /// Take the reply of the oldest read into `out`. `false` at the end of the file.
    fn take(&mut self, read: &PendingRead, reply: Reply, out: &mut Vec<u8>) -> Result<bool> {
        match reply {
            Reply::Data(data) => {
                // A server may answer with less than was asked; the rest is asked for again,
                // ahead of the reads already out, so the bytes stay in order.
                if (data.len() as u32) < read.length && !data.is_empty() {
                    let got = data.len() as u32;
                    let rest = self.ask(read.offset + got as u64, read.length - got)?;
                    self.waiting.push_front(rest);
                }
                out.extend_from_slice(&data);
                Ok(true)
            }
            Reply::Status {
                code: STATUS_EOF, ..
            } => Ok(false),
            Reply::Status { code, message } => Err(status_error(code, &message)),
            _ => Err(unexpected()),
        }
    }
}

/// A sequential read of one file.
#[napi]
pub struct SftpReader {
    state: tokio::sync::Mutex<ReadState>,
}

#[napi]
impl SftpReader {
    /// The next bytes of the file, or null at its end.
    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        let mut state = self.state.lock().await;
        if state.ended {
            return Ok(None);
        }
        while state.waiting.len() < state.depth {
            let read = state.ask(state.next, CHUNK)?;
            state.next += CHUNK as u64;
            state.waiting.push_back(read);
        }
        // A short file is over after a read or two; only a long one is worth reading far ahead.
        state.depth = (state.depth * 2).min(PIPELINE);
        let mut out = Vec::new();
        // Wait for the oldest read, then take along whatever has been answered since.
        let mut first = true;
        while let Some(mut read) = state.waiting.pop_front() {
            let reply = if first {
                (&mut read.reply).await.map_err(|_| session_ended())?
            } else {
                match read.reply.try_recv() {
                    Ok(reply) => reply,
                    Err(oneshot::error::TryRecvError::Empty) => {
                        state.waiting.push_front(read);
                        break;
                    }
                    Err(oneshot::error::TryRecvError::Closed) => return Err(session_ended()),
                }
            };
            first = false;
            if !state.take(&read, reply, &mut out)? {
                state.ended = true;
                state.waiting.clear();
                break;
            }
            if out.len() >= READ_BYTES {
                break;
            }
        }
        if out.is_empty() {
            return Ok(None);
        }
        Ok(Some(Buffer::from(out)))
    }
}

struct WriteState {
    core: Arc<SftpCore>,
    handle: Vec<u8>,
    next: u64,
    waiting: VecDeque<oneshot::Receiver<Reply>>,
}

impl WriteState {
    async fn settle_oldest(&mut self) -> Result<()> {
        let Some(reply) = self.waiting.pop_front() else {
            return Ok(());
        };
        match reply.await.map_err(|_| session_ended())? {
            Reply::Status {
                code: STATUS_OK, ..
            } => Ok(()),
            Reply::Status { code, message } => Err(status_error(code, &message)),
            _ => Err(unexpected()),
        }
    }
}

/// A sequential write of one file.
#[napi]
pub struct SftpWriter {
    state: tokio::sync::Mutex<WriteState>,
}

#[napi]
impl SftpWriter {
    /// Send the next bytes of the file. Settles once they are on their way; a write the server
    /// refused fails a later `write` or `finish`.
    #[napi]
    pub async fn write(&self, data: Buffer) -> Result<()> {
        let mut state = self.state.lock().await;
        for chunk in data.chunks(CHUNK as usize) {
            while state.waiting.len() >= PIPELINE {
                state.settle_oldest().await?;
            }
            let offset = state.next;
            let reply = state.core.send(WRITE, |out| {
                put_string(out, &state.handle);
                put_u64(out, offset);
                put_string(out, chunk);
            })?;
            state.next += chunk.len() as u64;
            state.waiting.push_back(reply);
        }
        Ok(())
    }

    /// Wait until the server has taken everything written.
    #[napi]
    pub async fn finish(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        let mut failure = None;
        while !state.waiting.is_empty() {
            if let Err(err) = state.settle_oldest().await {
                failure.get_or_insert(err);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

/// Run a program and speak SFTP over its standard streams, as `ssh -s host sftp` offers.
/// `env` is the program's whole environment. The program is ended with the session; when it
/// ends before the session is ready, what it said on stderr is the error.
#[napi]
pub async fn spawn_sftp(
    file: String,
    args: Vec<String>,
    env: Vec<EnvVar>,
    start_timeout_ms: u32,
) -> Result<SftpSession> {
    let mut command = tokio::process::Command::new(&file);
    command
        .args(&args)
        .env_clear()
        .envs(env.iter().map(|var| (&var.name, &var.value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|err| coded(crate::error::io_code(&err), err.to_string()))?;
    let missing = || coded("EIO", "the program has no standard streams");
    let stdin = child.stdin.take().ok_or_else(missing)?;
    let stdout = child.stdout.take().ok_or_else(missing)?;
    let complaints = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let complaints = complaints.clone();
        tokio::spawn(async move {
            let mut buffer = [0u8; 1024];
            while let Ok(read) = stderr.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                let mut text = lock(&complaints);
                text.push_str(&String::from_utf8_lossy(&buffer[..read]));
                if text.len() > 2048 {
                    let cut = (text.len() - 2048..text.len())
                        .find(|index| text.is_char_boundary(*index))
                        .unwrap_or(text.len());
                    text.drain(..cut);
                }
            }
        });
    }
    let start = SftpSession::start(tokio::io::join(stdout, stdin), Some(child));
    let started = if start_timeout_ms == 0 {
        start.await
    } else {
        match tokio::time::timeout(Duration::from_millis(start_timeout_ms as u64), start).await {
            Ok(result) => result,
            Err(_) => Err(coded(
                "ETIMEDOUT",
                "The SFTP session did not start in time.",
            )),
        }
    };
    started.map_err(|err| {
        // The program's last words are still on their way when its stream has just ended.
        let said = lock(&complaints).trim().to_string();
        if said.is_empty() {
            err
        } else {
            coded("SFTP_CLOSED", said)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_survive_a_round_trip() {
        let attrs = SftpAttrs {
            size: Some(5_000_000_000.0),
            uid: Some(1000),
            gid: Some(100),
            mode: Some(0o100644),
            atime: Some(1),
            mtime: Some(1_760_000_000),
        };
        let mut wire = Vec::new();
        put_attrs(&mut wire, Some(&attrs));
        let parsed = Reader { rest: &wire }.attrs().unwrap();
        assert_eq!(parsed.size, attrs.size);
        assert_eq!(parsed.mode, attrs.mode);
        assert_eq!(parsed.mtime, attrs.mtime);
        assert_eq!((parsed.uid, parsed.gid), (attrs.uid, attrs.gid));
    }

    #[test]
    fn a_status_without_a_message_still_parses() {
        let reply = parse_reply(STATUS, &2u32.to_be_bytes()).unwrap();
        assert!(matches!(reply, Reply::Status { code: 2, message } if message.is_empty()));
        assert!(status_error(2, "").reason.contains("No such file"));
    }

    /// A server that answers every read with at most `limit` bytes of a known file.
    async fn serve_short_reads(mut stream: tokio::io::DuplexStream, file: Vec<u8>, limit: usize) {
        let _ = read_packet(&mut stream).await;
        let mut version = Vec::new();
        put_u32(&mut version, 5);
        version.push(VERSION);
        put_u32(&mut version, 3);
        stream.write_all(&version).await.unwrap();
        while let Ok(packet) = read_packet(&mut stream).await {
            let mut reader = Reader { rest: &packet[1..] };
            let id = reader.u32().unwrap();
            reader.string().unwrap();
            let offset = reader.u64().unwrap() as usize;
            let length = reader.u32().unwrap() as usize;
            let mut reply = vec![0u8; 4];
            if offset >= file.len() {
                reply.push(STATUS);
                put_u32(&mut reply, id);
                put_u32(&mut reply, STATUS_EOF);
            } else {
                let end = file.len().min(offset + length.min(limit));
                reply.push(DATA);
                put_u32(&mut reply, id);
                put_string(&mut reply, &file[offset..end]);
            }
            let length = (reply.len() - 4) as u32;
            reply[..4].copy_from_slice(&length.to_be_bytes());
            stream.write_all(&reply).await.unwrap();
        }
    }

    #[tokio::test]
    async fn short_reads_are_filled_in_and_stay_in_order() {
        let file: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let (client, server) = tokio::io::duplex(64 * 1024);
        tokio::spawn(serve_short_reads(server, file.clone(), 10_000));
        let session = SftpSession::start(client, None).await.unwrap();
        let reader = session.reader(Buffer::from(vec![1u8, 0xff, 0x80]), 0.0);
        let mut got = Vec::new();
        while let Some(chunk) = reader.read().await.unwrap() {
            got.extend_from_slice(&chunk);
        }
        assert_eq!(got.len(), file.len());
        assert!(got == file);
    }

    #[tokio::test]
    async fn a_session_that_ends_fails_what_was_waiting_on_it() {
        let (client, mut server) = tokio::io::duplex(64 * 1024);
        let greeter = tokio::spawn(async move {
            let _ = read_packet(&mut server).await;
            let mut version = Vec::new();
            put_u32(&mut version, 5);
            version.push(VERSION);
            put_u32(&mut version, 3);
            server.write_all(&version).await.unwrap();
            let _ = read_packet(&mut server).await;
            // Leaves without answering.
        });
        let session = SftpSession::start(client, None).await.unwrap();
        let err = session.stat("/etc/hosts".into()).await.unwrap_err();
        assert!(err.reason.starts_with("[SFTP_CLOSED]"), "{}", err.reason);
        greeter.await.unwrap();
        let err = session.stat("/etc/hosts".into()).await.unwrap_err();
        assert!(err.reason.starts_with("[SFTP_CLOSED]"), "{}", err.reason);
    }
}
