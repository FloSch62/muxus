//! A connection to something on this computer that a channel is joined to without its bytes
//! passing through JavaScript: the X server behind a forwarded X11 connection.

use std::sync::Mutex;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::channel::lock;
use crate::error::{coded, io_error};
use crate::stream::{BoxedStream, connect_local, connect_tcp};

#[napi]
pub struct LocalStream {
    stream: Mutex<Option<BoxedStream>>,
    peer_address: Option<String>,
}

impl LocalStream {
    /// The stream itself, once: a channel takes it over.
    pub(crate) fn take(&self) -> Result<BoxedStream> {
        lock(&self.stream)
            .take()
            .ok_or_else(|| coded("STREAM_TAKEN", "the local stream is already in use"))
    }
}

#[napi]
impl LocalStream {
    /// The address of the far end of a TCP connection.
    #[napi(getter)]
    pub fn peer_address(&self) -> Option<String> {
        self.peer_address.clone()
    }

    #[napi]
    pub fn close(&self) {
        lock(&self.stream).take();
    }
}

async fn within<T>(timeout_ms: u32, work: impl Future<Output = std::io::Result<T>>) -> Result<T> {
    let result = if timeout_ms == 0 {
        work.await
    } else {
        match tokio::time::timeout(Duration::from_millis(timeout_ms as u64), work).await {
            Ok(result) => result,
            Err(_) => return Err(coded("ETIMEDOUT", "timed out connecting")),
        }
    };
    result.map_err(|err| io_error(&err))
}

/// Open a TCP connection on this computer's side. `timeoutMs` 0 waits as long as the system does.
#[napi]
pub async fn connect_local_tcp(host: String, port: u32, timeout_ms: u32) -> Result<LocalStream> {
    let stream = within(timeout_ms, connect_tcp(&host, port as u16)).await?;
    let peer_address = stream.peer_addr().ok().map(|addr| addr.ip().to_string());
    Ok(LocalStream {
        stream: Mutex::new(Some(Box::new(stream))),
        peer_address,
    })
}

/// Connect to a Unix socket (a leading NUL names a Linux abstract socket) or, on Windows, a
/// named pipe.
#[napi]
pub async fn connect_local_socket(path: String, timeout_ms: u32) -> Result<LocalStream> {
    let stream = within(timeout_ms, connect_local(&path)).await?;
    Ok(LocalStream {
        stream: Mutex::new(Some(stream)),
        peer_address: None,
    })
}
