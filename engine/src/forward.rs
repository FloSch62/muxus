//! Port forwards whose bytes never leave the engine: local (-L), dynamic (-D, a SOCKS5 CONNECT
//! server without authentication) and remote (-R).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::channel::{lock, tunnel};
use crate::client::{ClientEvent, ClientInner, SshClient};
use crate::error::{coded, disconnected, from_russh};

/// A listener on this computer whose connections travel through the SSH connection.
#[napi]
pub struct ForwardListener {
    port: u32,
    stop: watch::Sender<bool>,
}

#[napi]
impl ForwardListener {
    /// The port that was bound: the one chosen by the system when 0 was asked for.
    #[napi(getter)]
    pub fn port(&self) -> u32 {
        self.port
    }

    /// Stop listening. Connections already open carry on until they end.
    #[napi]
    pub fn close(&self) {
        self.stop.send_replace(true);
    }
}

impl Drop for ForwardListener {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

/// A listener on the server's side whose connections are carried to a target on this side.
#[napi]
pub struct RemoteForward {
    client: Arc<ClientInner>,
    bind_host: String,
    port: u32,
    closed: AtomicBool,
}

#[napi]
impl RemoteForward {
    /// The port the server listens on.
    #[napi(getter)]
    pub fn port(&self) -> u32 {
        self.port
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        lock(&self.client.shared.remote_forwards).remove(&self.port);
        let guard = self.client.handle.read().await;
        if let Some(handle) = guard.as_ref() {
            // The connection may be gone already, and the server's listener with it.
            let _ = handle
                .cancel_tcpip_forward(self.bind_host.clone(), self.port)
                .await;
        }
        Ok(())
    }
}

enum Kind {
    Local { host: String, port: u32 },
    Dynamic,
}

async fn bind(host: &str, port: u32) -> Result<TcpListener> {
    TcpListener::bind((host, port as u16))
        .await
        .map_err(|err| coded(crate::error::io_code(&err), err.to_string()))
}

async fn listen(
    client: &Arc<ClientInner>,
    bind_host: String,
    bind_port: u32,
    kind: Kind,
) -> Result<ForwardListener> {
    if client.handle.read().await.is_none() {
        return Err(disconnected());
    }
    let listener = bind(&bind_host, bind_port).await?;
    let port = listener
        .local_addr()
        .map(|addr| addr.port() as u32)
        .unwrap_or(bind_port);
    let (stop, mut stopped) = watch::channel(false);
    let client = client.clone();
    let kind = Arc::new(kind);
    tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = stopped.wait_for(|stop| *stop) => break,
                _ = client.shared.until_closed() => break,
            };
            let Ok((socket, _)) = accepted else { continue };
            let _ = socket.set_nodelay(true);
            let client = client.clone();
            let kind = kind.clone();
            tokio::spawn(async move {
                match &*kind {
                    Kind::Local { host, port: target } => {
                        serve_local(&client, socket, host, *target, port).await
                    }
                    Kind::Dynamic => serve_socks(&client, socket).await,
                }
            });
        }
    });
    Ok(ForwardListener { port, stop })
}

async fn serve_local(
    client: &ClientInner,
    socket: TcpStream,
    host: &str,
    target: u32,
    bind_port: u32,
) {
    let (origin_host, origin_port) = match socket.local_addr() {
        Ok(addr) => (addr.ip().to_string(), addr.port() as u32),
        Err(_) => ("127.0.0.1".to_string(), 0),
    };
    match client
        .open_direct_tcpip(host, target, &origin_host, origin_port)
        .await
    {
        Ok(channel) => tunnel(channel, socket, None).await,
        Err(err) => client.shared.emit(ClientEvent {
            kind: "forward-error".to_string(),
            message: Some(err.reason.clone()),
            suspect: None,
            port: Some(bind_port),
        }),
    }
}

/// Just enough SOCKS5 (RFC 1928) for browsers and command line tools: the no-authentication
/// greeting, then a CONNECT to an IPv4, domain or IPv6 target.
async fn serve_socks(client: &ClientInner, mut socket: TcpStream) {
    const VERSION: u8 = 5;
    const CONNECT: u8 = 1;
    async fn fail(socket: &mut TcpStream, code: u8) {
        let _ = socket
            .write_all(&[VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0])
            .await;
        let _ = socket.shutdown().await;
    }
    let target = async {
        let mut head = [0u8; 2];
        socket.read_exact(&mut head).await.ok()?;
        if head[0] != VERSION {
            return None;
        }
        let mut methods = vec![0u8; head[1] as usize];
        socket.read_exact(&mut methods).await.ok()?;
        socket.write_all(&[VERSION, 0]).await.ok()?;
        let mut request = [0u8; 4];
        socket.read_exact(&mut request).await.ok()?;
        if request[0] != VERSION || request[1] != CONNECT {
            fail(&mut socket, 7).await; // command not supported
            return None;
        }
        let host = match request[3] {
            1 => {
                let mut address = [0u8; 4];
                socket.read_exact(&mut address).await.ok()?;
                std::net::Ipv4Addr::from(address).to_string()
            }
            3 => {
                let mut length = [0u8; 1];
                socket.read_exact(&mut length).await.ok()?;
                let mut name = vec![0u8; length[0] as usize];
                socket.read_exact(&mut name).await.ok()?;
                String::from_utf8_lossy(&name).into_owned()
            }
            4 => {
                let mut address = [0u8; 16];
                socket.read_exact(&mut address).await.ok()?;
                // Every group written out: the server parses it either way.
                address
                    .chunks(2)
                    .map(|pair| format!("{:x}", u16::from_be_bytes([pair[0], pair[1]])))
                    .collect::<Vec<_>>()
                    .join(":")
            }
            _ => {
                fail(&mut socket, 8).await; // address type not supported
                return None;
            }
        };
        let mut port = [0u8; 2];
        socket.read_exact(&mut port).await.ok()?;
        Some((host, u16::from_be_bytes(port) as u32))
    }
    .await;
    let Some((host, port)) = target else { return };
    let (origin_host, origin_port) = match socket.peer_addr() {
        Ok(addr) => (addr.ip().to_string(), addr.port() as u32),
        Err(_) => ("127.0.0.1".to_string(), 0),
    };
    match client
        .open_direct_tcpip(&host, port, &origin_host, origin_port)
        .await
    {
        Ok(channel) => {
            if socket
                .write_all(&[VERSION, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                .await
                .is_ok()
            {
                tunnel(channel, socket, None).await;
            } else {
                let _ = channel.close().await;
            }
        }
        Err(_) => fail(&mut socket, 5).await, // connection refused
    }
}

#[napi]
impl SshClient {
    /// Listen on this computer and carry each connection to `targetHost:targetPort` as the
    /// server reaches it. A connection whose channel the server refuses is dropped and reported
    /// as a `forward-error` event.
    #[napi]
    pub async fn forward_local(
        &self,
        bind_host: String,
        bind_port: u32,
        target_host: String,
        target_port: u32,
    ) -> Result<ForwardListener> {
        listen(
            self.inner(),
            bind_host,
            bind_port,
            Kind::Local {
                host: target_host,
                port: target_port,
            },
        )
        .await
    }

    /// Listen on this computer as a SOCKS5 proxy whose connections leave from the server.
    #[napi]
    pub async fn forward_dynamic(
        &self,
        bind_host: String,
        bind_port: u32,
    ) -> Result<ForwardListener> {
        listen(self.inner(), bind_host, bind_port, Kind::Dynamic).await
    }

    /// Ask the server to listen on `bindHost:bindPort` and carry each connection to
    /// `targetHost:targetPort` on this side. Fails with `REMOTE_BIND_REFUSED` when the server
    /// says no.
    #[napi]
    pub async fn forward_remote(
        &self,
        bind_host: String,
        bind_port: u32,
        target_host: String,
        target_port: u32,
    ) -> Result<RemoteForward> {
        let client = self.inner().clone();
        let port = {
            let guard = client.handle.read().await;
            let handle = guard.as_ref().ok_or_else(disconnected)?;
            match handle.tcpip_forward(bind_host.clone(), bind_port).await {
                Ok(port) if port != 0 => port,
                Ok(_) => bind_port,
                Err(russh::Error::RequestDenied) => {
                    return Err(coded(
                        "REMOTE_BIND_REFUSED",
                        format!("the server refused to listen on {bind_host}:{bind_port}"),
                    ));
                }
                Err(err) => return Err(from_russh(err)),
            }
        };
        lock(&client.shared.remote_forwards).insert(port, (target_host, target_port as u16));
        Ok(RemoteForward {
            client,
            bind_host,
            port,
            closed: AtomicBool::new(false),
        })
    }
}
