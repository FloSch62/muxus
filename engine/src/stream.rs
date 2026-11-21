//! Byte streams the engine runs over or bridges to: TCP, Unix sockets, Windows pipes, Pageant.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;
use tokio::time::Instant;

/// Any byte stream an SSH session or a tunnel can run over.
pub trait ByteStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ByteStream for T {}

pub type BoxedStream = Box<dyn ByteStream>;

/// Resolve and connect like `net.connect`: every address the name resolves to is tried in turn.
pub async fn connect_tcp(host: &str, port: u16) -> io::Result<tokio::net::TcpStream> {
    let addresses: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|err| io::Error::new(io::ErrorKind::NotFound, NameNotResolved(err.to_string())))?
        .collect();
    let mut last = None;
    for address in addresses {
        match tokio::net::TcpStream::connect(address).await {
            Ok(stream) => {
                // Interactive traffic is tiny packets; none of them should wait on an ACK.
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(err) => last = Some(err),
        }
    }
    Err(last.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            NameNotResolved("no addresses".into()),
        )
    }))
}

/// Marks an I/O error as a failed name lookup, which has no `ErrorKind` of its own.
#[derive(Debug)]
pub struct NameNotResolved(pub String);

impl std::fmt::Display for NameNotResolved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "could not resolve the host name: {}", self.0)
    }
}

impl std::error::Error for NameNotResolved {}

pub fn is_name_not_resolved(err: &io::Error) -> bool {
    err.get_ref()
        .is_some_and(|inner| inner.is::<NameNotResolved>())
}

/// Connect to a local endpoint that speaks a stream protocol: an ssh-agent or an X server.
///
/// On Unix that is a socket path; a leading NUL names a Linux abstract socket. On Windows it is
/// a named pipe (`\\.\pipe\…`), the literal `pageant`, or the socket file of a Cygwin or MSYS
/// program.
pub async fn connect_local(endpoint: &str) -> io::Result<BoxedStream> {
    #[cfg(unix)]
    {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if let Some(name) = endpoint.strip_prefix('\0') {
            use std::os::linux::net::SocketAddrExt;
            let address = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())?;
            let stream = std::os::unix::net::UnixStream::connect_addr(&address)?;
            stream.set_nonblocking(true)?;
            return Ok(Box::new(tokio::net::UnixStream::from_std(stream)?));
        }
        Ok(Box::new(tokio::net::UnixStream::connect(endpoint).await?))
    }
    #[cfg(windows)]
    {
        windows::connect(endpoint).await
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::BoxedStream;

    /// Another client holds every instance of the pipe; one frees up shortly.
    const ERROR_PIPE_BUSY: i32 = 231;

    fn is_named_pipe(endpoint: &str) -> bool {
        let lower = endpoint.to_ascii_lowercase();
        lower.starts_with(r"\\.\pipe\") || lower.starts_with(r"\\?\pipe\")
    }

    pub async fn connect(endpoint: &str) -> io::Result<BoxedStream> {
        if endpoint.eq_ignore_ascii_case("pageant") {
            let stream = pageant::PageantStream::new()
                .await
                .map_err(|err| io::Error::new(io::ErrorKind::NotFound, err.to_string()))?;
            return Ok(Box::new(stream));
        }
        if is_named_pipe(endpoint) {
            for _ in 0..20 {
                match tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint) {
                    Ok(pipe) => return Ok(Box::new(pipe)),
                    Err(err) if err.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(err) => return Err(err),
                }
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the pipe stayed busy",
            ));
        }
        connect_cygwin(endpoint).await
    }

    /// A Cygwin or MSYS "socket" is a file naming a loopback TCP port and a secret the two
    /// sides exchange before any data.
    async fn connect_cygwin(path: &str) -> io::Result<BoxedStream> {
        let invalid = || io::Error::new(io::ErrorKind::InvalidData, "not a Cygwin socket file");
        let content = tokio::fs::read(path).await?;
        let text = String::from_utf8_lossy(&content);
        let rest = text.strip_prefix("!<socket >").ok_or_else(invalid)?;
        let mut fields = rest.trim_end_matches('\0').split_whitespace();
        let port: u16 = fields
            .next()
            .and_then(|p| p.parse().ok())
            .ok_or_else(invalid)?;
        let mut secret = [0u8; 16];
        // "s " marks the stream type and is absent from the oldest files.
        let key = fields
            .find(|field| field.contains('-'))
            .ok_or_else(invalid)?;
        for (index, part) in key.split('-').enumerate().take(4) {
            let word = u32::from_str_radix(part, 16).map_err(|_| invalid())?;
            secret[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        stream.write_all(&secret).await?;
        let mut echoed = [0u8; 16];
        stream.read_exact(&mut echoed).await?;
        if echoed != secret {
            return Err(invalid());
        }
        // Then the credentials of both ends: pid, uid and gid, which the far side only checks
        // for being there.
        let mut credentials = [0u8; 12];
        credentials[..4].copy_from_slice(&std::process::id().to_le_bytes());
        stream.write_all(&credentials).await?;
        stream.read_exact(&mut credentials).await?;
        Ok(Box::new(stream))
    }
}

/// When bytes last arrived on a transport, for the keepalive health watcher.
pub struct Activity {
    started: Instant,
    last_rx_ms: AtomicU64,
    /// Set while the watcher waits for the next byte.
    waiting: AtomicBool,
    notify: Notify,
}

impl Activity {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            started: Instant::now(),
            last_rx_ms: AtomicU64::new(0),
            waiting: AtomicBool::new(false),
            notify: Notify::new(),
        })
    }

    fn touch(&self) {
        self.last_rx_ms
            .store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
        if self.waiting.swap(false, Ordering::AcqRel) {
            self.notify.notify_one();
        }
    }

    fn idle(&self) -> Duration {
        let now = self.started.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last_rx_ms.load(Ordering::Relaxed)))
    }

    /// Passive keepalive health: two keepalive intervals of silence mean at least one keepalive
    /// went unanswered. No probe of its own is ever sent. `report` gets `true` for suspect and
    /// `false` when bytes arrive again; the future runs until it is dropped.
    pub async fn watch(self: Arc<Self>, interval: Duration, report: impl Fn(bool)) {
        if interval.is_zero() {
            return std::future::pending().await;
        }
        let limit = interval * 2;
        self.touch();
        loop {
            let idle = self.idle();
            if idle < limit {
                tokio::time::sleep(limit - idle).await;
                continue;
            }
            self.waiting.store(true, Ordering::Release);
            // A byte may have arrived between the check and the flag.
            if self.idle() < limit {
                self.waiting.store(false, Ordering::Release);
                continue;
            }
            report(true);
            self.notify.notified().await;
            report(false);
        }
    }
}

/// A transport that records when it receives bytes.
pub struct Observed<S> {
    inner: S,
    activity: Arc<Activity>,
}

impl<S> Observed<S> {
    pub fn new(inner: S, activity: Arc<Activity>) -> Self {
        Self { inner, activity }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Observed<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.activity.touch();
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Observed<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn silence_for_two_intervals_is_suspect_until_bytes_arrive() {
        let activity = Activity::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let watcher = tokio::spawn(
            activity
                .clone()
                .watch(Duration::from_secs(10), move |suspect| {
                    log.lock().unwrap().push(suspect)
                }),
        );
        tokio::time::sleep(Duration::from_secs(15)).await;
        assert!(seen.lock().unwrap().is_empty());
        activity.touch();
        tokio::time::sleep(Duration::from_secs(19)).await;
        assert!(seen.lock().unwrap().is_empty());
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*seen.lock().unwrap(), [true]);
        activity.touch();
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert_eq!(*seen.lock().unwrap(), [true, false]);
        watcher.abort();
    }
}
