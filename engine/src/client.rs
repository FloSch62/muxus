//! One SSH connection: the transport, the login and the channels opened on it.
//!
//! Policy stays in TypeScript. Whether a host key is trusted, which login method comes next and
//! what the user is asked are decided there, through the callbacks and the one-step login
//! methods below.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use russh::client::{
    AuthResult, Config, DisconnectReason, GexParams, Handle, KeyboardInteractiveAuthResponse, Msg,
    Session,
};
use russh::keys::agent::AgentIdentity;
use russh::keys::{Certificate, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, ChannelOpenFailure, Disconnect, MethodSet};
use tokio::sync::{RwLock, watch};

use crate::algorithms::{Requested, preferred};
use crate::channel::{ChannelCore, SshChannel, lock, tunnel};
use crate::error::{coded, disconnected, from_russh, io_code};
use crate::keys::{SshPrivateKey, hash_from_name, sign};
use crate::proxy::{ProxyCommand, ProxyStatus};
use crate::sftp::SftpSession;
use crate::stream::{
    Activity, BoxedStream, Observed, connect_local, connect_tcp, is_name_not_resolved,
};

type HostKeyFn = ThreadsafeFunction<Buffer, Promise<bool>, Buffer, Status, false, true>;
type EventFn = ThreadsafeFunction<ClientEvent, (), ClientEvent, Status, false, true>;
type X11Fn = ThreadsafeFunction<IncomingChannel, (), IncomingChannel, Status, false, true>;
type SignFn = ThreadsafeFunction<Buffer, Promise<Buffer>, Buffer, Status, false, true>;

/// How to reach and talk to a host. The algorithm lists are final: absent keeps the engine's
/// default for that category.
#[napi(object)]
pub struct ClientOptions {
    pub host: String,
    pub port: u32,
    /// Shell command whose standard streams carry the session, instead of a TCP connection.
    pub proxy_command: Option<String>,
    pub kex: Option<Vec<String>>,
    pub host_key: Option<Vec<String>>,
    pub cipher: Option<Vec<String>>,
    pub mac: Option<Vec<String>>,
    pub compression: Option<Vec<String>>,
    /// Milliseconds of silence after which a keepalive is sent; 0 or absent sends none.
    pub keepalive_interval_ms: Option<u32>,
    /// Unanswered keepalives after which the connection is given up.
    pub keepalive_count_max: Option<u32>,
    /// The local ssh-agent to forward: sessions ask for forwarding, and the server's agent
    /// connections are joined to it.
    pub agent_forward: Option<String>,
}

/// `kind` is `banner` (with `message`), `health` (with `suspect`), `forward-error` (with
/// `message` and `port`) or `close` (with the reason in `message` when one is known).
#[napi(object)]
pub struct ClientEvent {
    pub kind: String,
    pub message: Option<String>,
    pub suspect: Option<bool>,
    pub port: Option<u32>,
}

impl ClientEvent {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            message: None,
            suspect: None,
            port: None,
        }
    }
}

/// What the key exchange settled on.
#[napi(object)]
pub struct Handshake {
    /// The software part of the server's identification string.
    pub server_software: Option<String>,
    pub kex: Option<String>,
    pub cipher: Option<String>,
    /// Client-to-server compression.
    pub compression: Option<String>,
}

/// The server's answer to one login attempt.
#[napi(object)]
pub struct AuthOutcome {
    pub success: bool,
    /// Methods the server still accepts after a failure.
    pub remaining: Vec<String>,
    /// The attempt was accepted, but the server wants another method as well.
    pub partial: bool,
}

#[napi(object)]
pub struct KeyboardPrompt {
    pub prompt: String,
    pub echo: bool,
}

/// One step of keyboard-interactive: either the server's verdict or questions to answer.
#[napi(object)]
pub struct KeyboardStep {
    pub outcome: Option<AuthOutcome>,
    pub name: Option<String>,
    pub instructions: Option<String>,
    pub prompts: Option<Vec<KeyboardPrompt>>,
}

#[napi(object)]
pub struct PtyRequest {
    pub term: String,
    pub cols: u32,
    pub rows: u32,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// The erase character the terminal sends (VERASE).
    pub erase: Option<u32>,
}

#[napi(object)]
pub struct X11Request {
    pub single: bool,
    pub protocol: String,
    /// Hex cookie the server hands to X clients.
    pub cookie: String,
    pub screen: u32,
}

#[napi(object)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// A session channel: a shell unless `command` or `subsystem` is set.
#[napi(object)]
pub struct SessionRequest {
    pub pty: Option<PtyRequest>,
    pub env: Option<Vec<EnvVar>>,
    pub x11: Option<X11Request>,
    pub command: Option<String>,
    pub subsystem: Option<String>,
}

struct Callbacks {
    host_key: HostKeyFn,
    events: EventFn,
}

/// State the session task and the JavaScript-facing object share.
pub(crate) struct Shared {
    callbacks: Mutex<Option<Arc<Callbacks>>>,
    x11: Mutex<Option<Arc<X11Fn>>>,
    accepted_key: Mutex<Option<Vec<u8>>>,
    handshake: Mutex<Option<Handshake>>,
    close_reason: Mutex<Option<String>>,
    closed: watch::Sender<bool>,
    /// Remote forwards by the port the server listens on: where their connections go.
    pub(crate) remote_forwards: Mutex<HashMap<u32, (String, u16)>>,
    agent_forward: Option<String>,
}

impl Shared {
    fn callbacks(&self) -> Option<Arc<Callbacks>> {
        lock(&self.callbacks).clone()
    }

    pub(crate) fn emit(&self, event: ClientEvent) {
        if let Some(callbacks) = self.callbacks() {
            callbacks
                .events
                .call(event, ThreadsafeFunctionCallMode::NonBlocking);
        }
    }

    fn set_close_reason(&self, reason: String) {
        let mut slot = lock(&self.close_reason);
        if slot.is_none() && !reason.is_empty() {
            *slot = Some(reason);
        }
    }

    fn finish(&self) {
        if self.closed.send_replace(true) {
            return;
        }
        self.emit(ClientEvent {
            message: lock(&self.close_reason).clone(),
            ..ClientEvent::new("close")
        });
        // The callbacks keep the JavaScript side of this connection alive; let it go.
        lock(&self.callbacks).take();
        lock(&self.x11).take();
    }

    pub(crate) async fn until_closed(&self) {
        let mut closed = self.closed.subscribe();
        let _ = closed.wait_for(|closed| *closed).await;
    }
}

pub(crate) struct ClientHandler {
    shared: Arc<Shared>,
}

impl Drop for ClientHandler {
    fn drop(&mut self) {
        // The session task owns the handler, so this runs exactly when the session ends.
        self.shared.finish();
    }
}

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut Session,
    ) -> std::result::Result<(), Self::Error> {
        self.shared.emit(ClientEvent {
            message: Some(banner.to_string()),
            ..ClientEvent::new("banner")
        });
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let blob = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.to_bytes()?,
            // No certificate host key algorithm is offered, so none can be chosen.
            PublicKeyOrCertificate::Certificate(_) => return Ok(false),
        };
        if let Some(accepted) = lock(&self.shared.accepted_key).clone() {
            // A later key exchange must present the key that was accepted at the start.
            return Ok(accepted == blob);
        }
        let Some(callbacks) = self.shared.callbacks() else {
            return Ok(false);
        };
        let verdict = match callbacks
            .host_key
            .call_async_catch(Buffer::from(blob.clone()))
            .await
        {
            Ok(promise) => promise.await.unwrap_or(false),
            Err(_) => false,
        };
        if verdict {
            *lock(&self.shared.accepted_key) = Some(blob);
        }
        Ok(verdict)
    }

    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        names: &russh::Names,
        session: &mut Session,
    ) -> std::result::Result<(), Self::Error> {
        let identification = String::from_utf8_lossy(session.remote_sshid()).into_owned();
        // "SSH-2.0-OpenSSH_9.6p1 Ubuntu" names the software after the second dash.
        let server_software = identification
            .splitn(3, '-')
            .nth(2)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        *lock(&self.shared.handshake) = Some(Handshake {
            server_software,
            kex: Some(names.kex.as_ref().to_string()),
            cipher: Some(names.cipher.as_ref().to_string()),
            compression: Some(
                match names.client_compression {
                    russh::compression::Compression::None => "none",
                    russh::compression::Compression::Zlib => "zlib",
                    russh::compression::Compression::ZlibOpenSSH => "zlib@openssh.com",
                }
                .to_string(),
            ),
        });
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        channel: Channel<Msg>,
        originator_address: &str,
        originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut Session,
    ) -> std::result::Result<(), Self::Error> {
        let handler = lock(&self.shared.x11).clone();
        match handler {
            // The answer comes from JavaScript, which first has to reach the local X server.
            Some(handler) => {
                handler.call(
                    IncomingChannel {
                        pending: Mutex::new(Some((channel, reply))),
                        origin_address: originator_address.to_string(),
                        origin_port: originator_port,
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
            None => {
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await
            }
        }
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut Session,
    ) -> std::result::Result<(), Self::Error> {
        let target = lock(&self.shared.remote_forwards)
            .get(&connected_port)
            .cloned();
        let Some((host, port)) = target else {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };
        // Connecting must not hold up the session, which carries every other channel.
        tokio::spawn(async move {
            match connect_tcp(&host, port).await {
                Ok(socket) => {
                    reply.accept().await;
                    tunnel(channel, socket, None).await;
                }
                Err(_) => reply.reject(ChannelOpenFailure::ConnectFailed).await,
            }
        });
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut Session,
    ) -> std::result::Result<(), Self::Error> {
        let Some(endpoint) = self.shared.agent_forward.clone() else {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };
        tokio::spawn(async move {
            match connect_local(&endpoint).await {
                Ok(agent) => {
                    reply.accept().await;
                    tunnel(channel, agent, None).await;
                }
                Err(_) => reply.reject(ChannelOpenFailure::ConnectFailed).await,
            }
        });
        Ok(())
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> std::result::Result<(), Self::Error> {
        match reason {
            DisconnectReason::ReceivedDisconnect(info) => {
                self.shared.set_close_reason(info.message);
                Ok(())
            }
            DisconnectReason::Error(err) => {
                self.shared.set_close_reason(close_reason(&err));
                Err(err)
            }
        }
    }
}

/// Why a live connection ended, in words for the user.
fn close_reason(err: &russh::Error) -> String {
    match err {
        russh::Error::IO(io) => match io_code(io) {
            "EIO" => io.to_string(),
            code => format!("{code}: {io}"),
        },
        russh::Error::KeepaliveTimeout => "Keepalive timeout".to_string(),
        // The peer simply went away; there is nothing to add to "disconnected".
        russh::Error::HUP | russh::Error::Disconnect | russh::Error::SendError => String::new(),
        other => other.to_string(),
    }
}

/// A connection the server asks to open towards us; answer it once.
#[napi]
pub struct IncomingChannel {
    pending: Mutex<Option<(Channel<Msg>, russh::client::ChannelOpenHandle)>>,
    origin_address: String,
    origin_port: u32,
}

#[napi]
impl IncomingChannel {
    #[napi(getter)]
    pub fn origin_address(&self) -> String {
        self.origin_address.clone()
    }

    #[napi(getter)]
    pub fn origin_port(&self) -> u32 {
        self.origin_port
    }

    #[napi(ts_return_type = "Promise<SshChannel>")]
    pub fn accept<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, SshChannel>> {
        let pending = lock(&self.pending).take();
        env.spawn_future(async move {
            let (channel, reply) = pending
                .ok_or_else(|| coded("CHANNEL_CLOSED", "the request was already answered"))?;
            reply.accept().await;
            Ok(SshChannel::new(ChannelCore::start(channel)))
        })
    }

    #[napi]
    pub fn reject(&self) {
        // Dropping the reply handle refuses the channel.
        lock(&self.pending).take();
    }
}

/// A direct-tcpip channel that will carry another SSH connection (a jump host hop).
#[napi]
pub struct SshTunnel {
    channel: Mutex<Option<Channel<Msg>>>,
}

pub(crate) struct ClientInner {
    options: ClientOptions,
    via: Mutex<Option<Channel<Msg>>>,
    pub(crate) handle: RwLock<Option<Handle<ClientHandler>>>,
    pub(crate) shared: Arc<Shared>,
    started: AtomicBool,
    abort: watch::Sender<bool>,
}

impl ClientInner {
    async fn aborted(&self) {
        let mut abort = self.abort.subscribe();
        let _ = abort.wait_for(|aborted| *aborted).await;
    }

    /// Run a login step, giving up when the connection is closed from our side meanwhile.
    async fn or_abort<T>(&self, work: impl Future<Output = Result<T>>) -> Result<T> {
        tokio::select! {
            result = work => result,
            _ = self.aborted() => Err(coded("ABORTED", "the connection attempt was cancelled")),
        }
    }

    pub(crate) async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u32,
        origin_host: &str,
        origin_port: u32,
    ) -> Result<Channel<Msg>> {
        let guard = self.handle.read().await;
        let handle = guard.as_ref().ok_or_else(disconnected)?;
        handle
            .channel_open_direct_tcpip(host, port, origin_host, origin_port)
            .await
            .map_err(from_russh)
    }

    async fn open_session_channel(&self) -> Result<Channel<Msg>> {
        let guard = self.handle.read().await;
        let handle = guard.as_ref().ok_or_else(disconnected)?;
        handle.channel_open_session().await.map_err(from_russh)
    }
}

fn outcome(result: AuthResult) -> AuthOutcome {
    match result {
        AuthResult::Success => AuthOutcome {
            success: true,
            remaining: Vec::new(),
            partial: false,
        },
        AuthResult::Failure {
            remaining_methods,
            partial_success,
        } => failure(&remaining_methods, partial_success),
    }
}

fn failure(remaining: &MethodSet, partial: bool) -> AuthOutcome {
    AuthOutcome {
        success: false,
        remaining: remaining
            .iter()
            .map(|method| <&'static str>::from(method).to_string())
            .collect(),
        partial,
    }
}

fn keyboard_step(response: KeyboardInteractiveAuthResponse) -> KeyboardStep {
    match response {
        KeyboardInteractiveAuthResponse::Success => KeyboardStep {
            outcome: Some(outcome(AuthResult::Success)),
            name: None,
            instructions: None,
            prompts: None,
        },
        KeyboardInteractiveAuthResponse::Failure {
            remaining_methods,
            partial_success,
        } => KeyboardStep {
            outcome: Some(failure(&remaining_methods, partial_success)),
            name: None,
            instructions: None,
            prompts: None,
        },
        KeyboardInteractiveAuthResponse::InfoRequest {
            name,
            instructions,
            prompts,
        } => KeyboardStep {
            outcome: None,
            name: Some(name),
            instructions: Some(instructions),
            prompts: Some(
                prompts
                    .into_iter()
                    .map(|prompt| KeyboardPrompt {
                        prompt: prompt.prompt,
                        echo: prompt.echo,
                    })
                    .collect(),
            ),
        },
    }
}

/// A TCP connection that could not be made, with the errno Node would have named.
fn connect_error(err: std::io::Error) -> Error {
    if is_name_not_resolved(&err) {
        return coded("ENOTFOUND", err.to_string());
    }
    coded(io_code(&err), err.to_string())
}

/// The handshake failed; the wording is what the rest of Muxus matches hints against.
fn handshake_error(err: russh::Error, shared: &Shared) -> Error {
    match err {
        russh::Error::NoCommonAlgo { kind, .. } => {
            let what = match kind {
                russh::AlgorithmKind::Kex => "key exchange algorithm",
                russh::AlgorithmKind::Key => "host key format",
                russh::AlgorithmKind::Cipher => "cipher",
                russh::AlgorithmKind::Compression => "compression algorithm",
                russh::AlgorithmKind::Mac => "MAC",
            };
            coded(
                "NO_MATCHING_ALGORITHM",
                format!("Handshake failed: no matching {what}"),
            )
        }
        russh::Error::UnknownKey => coded("HOST_KEY_REJECTED", "Host denied (verification failed)"),
        russh::Error::IO(io) => coded(io_code(&io), io.to_string()),
        russh::Error::Disconnect | russh::Error::HUP | russh::Error::SendError => coded(
            "DISCONNECTED",
            lock(&shared.close_reason)
                .clone()
                .unwrap_or_else(|| "SSH connection closed before it became ready.".to_string()),
        ),
        other => coded("PROTOCOL", other.to_string()),
    }
}

/// Signs with a key file held in memory, for a certificate login.
struct KeySigner(Arc<russh::keys::PrivateKey>);

#[derive(Debug)]
struct SignFailure(String);

impl From<russh::SendError> for SignFailure {
    fn from(_: russh::SendError) -> Self {
        SignFailure("the SSH session closed during authentication".to_string())
    }
}

/// The engine wants the signed data back with the signature appended as one field.
fn with_signature(mut data: Vec<u8>, signature: &[u8]) -> Vec<u8> {
    data.extend_from_slice(&(signature.len() as u32).to_be_bytes());
    data.extend_from_slice(signature);
    data
}

impl russh::Signer for KeySigner {
    type Error = SignFailure;

    fn auth_sign(
        &mut self,
        _key: &AgentIdentity,
        hash_alg: Option<HashAlg>,
        to_sign: Vec<u8>,
    ) -> impl Future<Output = std::result::Result<Vec<u8>, Self::Error>> + Send {
        let key = self.0.clone();
        async move {
            let signature =
                sign(&key, hash_alg, &to_sign).map_err(|err| SignFailure(err.reason.clone()))?;
            Ok(with_signature(to_sign, &signature))
        }
    }
}

/// Signs through a JavaScript function: an ssh-agent, or a security key behind one.
struct CallbackSigner(SignFn);

impl russh::Signer for CallbackSigner {
    type Error = SignFailure;

    fn auth_sign(
        &mut self,
        _key: &AgentIdentity,
        _hash_alg: Option<HashAlg>,
        to_sign: Vec<u8>,
    ) -> impl Future<Output = std::result::Result<Vec<u8>, Self::Error>> + Send {
        let sign = &self.0;
        async move {
            let promise = sign
                .call_async_catch(Buffer::from(to_sign.clone()))
                .await
                .map_err(|err| SignFailure(err.reason.clone()))?;
            let signature = promise
                .await
                .map_err(|err| SignFailure(err.reason.clone()))?;
            Ok(with_signature(to_sign, &signature))
        }
    }
}

fn is_certificate(blob: &[u8]) -> bool {
    blob.get(..4)
        .map(|len| u32::from_be_bytes([len[0], len[1], len[2], len[3]]) as usize)
        .and_then(|len| blob.get(4..4 + len))
        .is_some_and(|name| name.ends_with(b"-cert-v01@openssh.com"))
}

/// An SSH connection to one host.
#[napi]
pub struct SshClient {
    inner: Arc<ClientInner>,
}

#[napi]
impl SshClient {
    /// `onHostKey` decides whether the server's key (SSH wire format) is trusted. `onEvent`
    /// hears banners, health changes and the end of the connection.
    #[napi(
        constructor,
        ts_args_type = "options: ClientOptions, onHostKey: (key: Buffer) => Promise<boolean>, onEvent: (event: ClientEvent) => void"
    )]
    pub fn new(options: ClientOptions, on_host_key: HostKeyFn, on_event: EventFn) -> Self {
        let shared = Arc::new(Shared {
            callbacks: Mutex::new(Some(Arc::new(Callbacks {
                host_key: on_host_key,
                events: on_event,
            }))),
            x11: Mutex::new(None),
            accepted_key: Mutex::new(None),
            handshake: Mutex::new(None),
            close_reason: Mutex::new(None),
            closed: watch::channel(false).0,
            remote_forwards: Mutex::new(HashMap::new()),
            agent_forward: options.agent_forward.clone(),
        });
        Self {
            inner: Arc::new(ClientInner {
                options,
                via: Mutex::new(None),
                handle: RwLock::new(None),
                shared,
                started: AtomicBool::new(false),
                abort: watch::channel(false).0,
            }),
        }
    }

    /// Run the connection over a channel of another connection instead of dialing the host.
    #[napi]
    pub fn use_tunnel(&self, tunnel: &SshTunnel) -> Result<()> {
        let channel = lock(&tunnel.channel)
            .take()
            .ok_or_else(|| coded("STREAM_TAKEN", "the tunnel is already in use"))?;
        *lock(&self.inner.via) = Some(channel);
        Ok(())
    }

    /// Hear about X11 connections the server forwards. Without a handler they are refused.
    #[napi(ts_args_type = "handler: (incoming: IncomingChannel) => void")]
    pub fn on_x11(&self, handler: X11Fn) {
        *lock(&self.inner.shared.x11) = Some(Arc::new(handler));
    }

    /// Reach the host and exchange keys. The login follows through the `auth*` methods.
    #[napi]
    pub async fn connect(&self) -> Result<Handshake> {
        let inner = &self.inner;
        if inner.started.swap(true, Ordering::AcqRel) {
            return Err(coded("INVALID_STATE", "connect was already called"));
        }
        let options = &inner.options;
        let keepalive = Duration::from_millis(options.keepalive_interval_ms.unwrap_or(0) as u64);
        let config = Arc::new(Config {
            preferred: preferred(&Requested {
                kex: options.kex.clone(),
                host_key: options.host_key.clone(),
                cipher: options.cipher.clone(),
                mac: options.mac.clone(),
                compression: options.compression.clone(),
            }),
            keepalive_interval: (!keepalive.is_zero()).then_some(keepalive),
            keepalive_max: options.keepalive_count_max.unwrap_or(3) as usize,
            nodelay: true,
            gex: GexParams::new(2048, 4096, 8192).unwrap_or_default(),
            ..Config::default()
        });
        let activity = Activity::new();
        let proxy: OnceLock<ProxyStatus> = OnceLock::new();
        let via = lock(&inner.via).take();
        let handler = ClientHandler {
            shared: inner.shared.clone(),
        };
        let work = async {
            let stream: BoxedStream = match (via, &options.proxy_command) {
                (Some(channel), _) => Box::new(channel.into_stream()),
                (None, Some(command)) => {
                    let command = ProxyCommand::spawn(command).map_err(|err| {
                        coded(
                            "PROXY_COMMAND",
                            format!("ProxyCommand could not start: {err}"),
                        )
                    })?;
                    let _ = proxy.set(command.status());
                    Box::new(command)
                }
                (None, None) => Box::new(
                    connect_tcp(&options.host, options.port as u16)
                        .await
                        .map_err(connect_error)?,
                ),
            };
            russh::client::connect_stream(config, Observed::new(stream, activity.clone()), handler)
                .await
                .map_err(|err| handshake_error(err, &inner.shared))
        };
        let handle = match inner.or_abort(work).await {
            Ok(handle) => handle,
            Err(err) => {
                // A ProxyCommand that died explains the failure better than its closed stream.
                if let Some(status) = proxy.get()
                    && let Some(message) = status.failure(Duration::from_secs(1)).await
                {
                    return Err(coded("PROXY_COMMAND", message));
                }
                return Err(err);
            }
        };
        *inner.handle.write().await = Some(handle);
        if !keepalive.is_zero() {
            let shared = inner.shared.clone();
            let watched = shared.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = activity.watch(keepalive, move |suspect| {
                        watched.emit(ClientEvent {
                            suspect: Some(suspect),
                            ..ClientEvent::new("health")
                        })
                    }) => {}
                    _ = shared.until_closed() => {}
                }
            });
        }
        Ok(lock(&inner.shared.handshake).take().unwrap_or(Handshake {
            server_software: None,
            kex: None,
            cipher: None,
            compression: None,
        }))
    }

    /// End the connection, or the attempt to make it.
    #[napi]
    pub async fn close(&self) -> Result<()> {
        // Ends a connect or a login step in flight, which then lets go of the handle.
        self.inner.abort.send_replace(true);
        // Shared with channels that are still being opened: the disconnect must not wait
        // for a server that is slow to answer one of them.
        let guard = self.inner.handle.read().await;
        if let Some(handle) = guard.as_ref() {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        }
        Ok(())
    }

    #[napi(getter)]
    pub fn closed(&self) -> bool {
        *self.inner.shared.closed.borrow()
    }

    #[napi]
    pub async fn auth_none(&self, user: String) -> Result<AuthOutcome> {
        let inner = &self.inner;
        inner
            .or_abort(async {
                let mut guard = inner.handle.write().await;
                let handle = guard.as_mut().ok_or_else(disconnected)?;
                handle
                    .authenticate_none(user)
                    .await
                    .map(outcome)
                    .map_err(from_russh)
            })
            .await
    }

    #[napi]
    pub async fn auth_password(&self, user: String, password: String) -> Result<AuthOutcome> {
        let inner = &self.inner;
        inner
            .or_abort(async {
                let mut guard = inner.handle.write().await;
                let handle = guard.as_mut().ok_or_else(disconnected)?;
                handle
                    .authenticate_password(user, password)
                    .await
                    .map(outcome)
                    .map_err(from_russh)
            })
            .await
    }

    /// The best RSA signature hash the server said it takes: `sha512`, `sha256`, `sha1` when it
    /// named only ssh-rsa, or null when it said nothing.
    #[napi]
    pub async fn rsa_hash(&self) -> Result<Option<String>> {
        let guard = self.inner.handle.read().await;
        let handle = guard.as_ref().ok_or_else(disconnected)?;
        Ok(
            match handle.best_supported_rsa_hash().await.map_err(from_russh)? {
                None => None,
                Some(None) => Some("sha1".to_string()),
                Some(Some(HashAlg::Sha512)) => Some("sha512".to_string()),
                Some(Some(_)) => Some("sha256".to_string()),
            },
        )
    }

    /// Log in with a key file. `rsaHash` picks the RSA signature variant.
    #[napi(ts_return_type = "Promise<AuthOutcome>")]
    pub fn auth_public_key<'env>(
        &self,
        env: &'env Env,
        user: String,
        key: &SshPrivateKey,
        rsa_hash: Option<String>,
    ) -> Result<PromiseRaw<'env, AuthOutcome>> {
        let inner = self.inner.clone();
        let key = key.key.clone();
        let hash = hash_from_name(rsa_hash.as_deref())?;
        env.spawn_future(async move {
            inner
                .or_abort(async {
                    let mut guard = inner.handle.write().await;
                    let handle = guard.as_mut().ok_or_else(disconnected)?;
                    handle
                        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(key, hash))
                        .await
                        .map(outcome)
                        .map_err(from_russh)
                })
                .await
        })
    }

    /// Log in with an OpenSSH certificate (SSH wire format) and the key file it certifies.
    #[napi(ts_return_type = "Promise<AuthOutcome>")]
    pub fn auth_certificate<'env>(
        &self,
        env: &'env Env,
        user: String,
        key: &SshPrivateKey,
        certificate: Buffer,
        rsa_hash: Option<String>,
    ) -> Result<PromiseRaw<'env, AuthOutcome>> {
        let inner = self.inner.clone();
        let key = key.key.clone();
        let hash = hash_from_name(rsa_hash.as_deref())?;
        let certificate = Certificate::from_bytes(&certificate)
            .map_err(|err| coded("KEY_INVALID", format!("malformed certificate: {err}")))?;
        env.spawn_future(async move {
            inner
                .or_abort(async {
                    let mut guard = inner.handle.write().await;
                    let handle = guard.as_mut().ok_or_else(disconnected)?;
                    let mut signer = KeySigner(key);
                    handle
                        .authenticate_certificate_with(user, certificate, hash, &mut signer)
                        .await
                        .map(outcome)
                        .map_err(|err| coded("SIGN_FAILED", err.0))
                })
                .await
        })
    }

    /// Log in with an identity (a public key or a certificate in SSH wire format) whose private
    /// half signs elsewhere. `sign` gets the data to sign once the server accepts the identity
    /// and resolves with the SSH signature blob; a rejection fails this call with `SIGN_FAILED`
    /// and leaves the connection ready for the next method.
    #[napi(
        ts_args_type = "user: string, identity: Buffer, rsaHash: string | undefined | null, sign: (data: Buffer) => Promise<Buffer>"
    )]
    pub async fn auth_signer(
        &self,
        user: String,
        identity: Buffer,
        rsa_hash: Option<String>,
        sign: SignFn,
    ) -> Result<AuthOutcome> {
        let inner = &self.inner;
        let hash = hash_from_name(rsa_hash.as_deref())?;
        let invalid = |err: &dyn std::fmt::Display| {
            coded("KEY_INVALID", format!("unsupported identity: {err}"))
        };
        let mut signer = CallbackSigner(sign);
        inner
            .or_abort(async {
                let mut guard = inner.handle.write().await;
                let handle = guard.as_mut().ok_or_else(disconnected)?;
                let result = if is_certificate(&identity) {
                    let certificate =
                        Certificate::from_bytes(&identity).map_err(|err| invalid(&err))?;
                    handle
                        .authenticate_certificate_with(user, certificate, hash, &mut signer)
                        .await
                } else {
                    let key = PublicKey::from_bytes(&identity).map_err(|err| invalid(&err))?;
                    handle
                        .authenticate_publickey_with(user, key, hash, &mut signer)
                        .await
                };
                result
                    .map(outcome)
                    .map_err(|err| coded("SIGN_FAILED", err.0))
            })
            .await
    }

    #[napi]
    pub async fn auth_keyboard_start(&self, user: String) -> Result<KeyboardStep> {
        let inner = &self.inner;
        inner
            .or_abort(async {
                let mut guard = inner.handle.write().await;
                let handle = guard.as_mut().ok_or_else(disconnected)?;
                handle
                    .authenticate_keyboard_interactive_start(user, None::<String>)
                    .await
                    .map(keyboard_step)
                    .map_err(from_russh)
            })
            .await
    }

    #[napi]
    pub async fn auth_keyboard_respond(&self, answers: Vec<String>) -> Result<KeyboardStep> {
        let inner = &self.inner;
        inner
            .or_abort(async {
                let mut guard = inner.handle.write().await;
                let handle = guard.as_mut().ok_or_else(disconnected)?;
                handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map(keyboard_step)
                    .map_err(from_russh)
            })
            .await
    }

    /// Open a session channel and make its requests in the order ssh(1) does: X11, agent
    /// forwarding, terminal, environment, then the shell, command or subsystem. A refused X11
    /// request costs X11, not the session (`x11Forwarded` tells); a refused terminal fails with
    /// `PTY_REFUSED`, and the program itself with `SHELL_REFUSED`, `EXEC_REFUSED` or
    /// `SUBSYSTEM_REFUSED`.
    #[napi]
    pub async fn open_session(&self, request: SessionRequest) -> Result<SshChannel> {
        let channel = self.inner.open_session_channel().await?;
        let core = ChannelCore::start(channel);
        let setup = async {
            if let Some(x11) = &request.x11
                && core
                    .request_x11(x11.single, &x11.protocol, &x11.cookie, x11.screen)
                    .await?
            {
                core.mark_x11_forwarded();
            }
            let program = request.subsystem.is_none();
            if program && self.inner.shared.agent_forward.is_some() {
                core.request_agent_forwarding().await?;
            }
            if let Some(pty) = &request.pty {
                let modes: Vec<(russh::Pty, u32)> = pty
                    .erase
                    .map(|erase| (russh::Pty::VERASE, erase))
                    .into_iter()
                    .collect();
                let accepted = core
                    .request_pty(
                        &pty.term,
                        pty.cols,
                        pty.rows,
                        pty.width.unwrap_or(0),
                        pty.height.unwrap_or(0),
                        &modes,
                    )
                    .await?;
                if !accepted {
                    return Err(coded("PTY_REFUSED", "Unable to request a pseudo-terminal"));
                }
            }
            for variable in request.env.iter().flatten() {
                core.set_env(&variable.name, &variable.value).await?;
            }
            if let Some(name) = &request.subsystem {
                if !core.request_subsystem(name).await? {
                    return Err(coded(
                        "SUBSYSTEM_REFUSED",
                        format!("Unable to start subsystem: {name}"),
                    ));
                }
            } else if let Some(command) = &request.command {
                if !core.request_exec(command).await? {
                    return Err(coded("EXEC_REFUSED", "Unable to exec"));
                }
            } else if !core.request_shell().await? {
                return Err(coded("SHELL_REFUSED", "Unable to start shell"));
            }
            Ok(())
        };
        match setup.await {
            Ok(()) => Ok(SshChannel::new(core)),
            Err(err) => {
                core.close().await;
                Err(err)
            }
        }
    }

    /// A channel to `host:port`, resolved and dialed on the server's side.
    #[napi]
    pub async fn open_direct_tcpip(
        &self,
        host: String,
        port: u32,
        origin_host: String,
        origin_port: u32,
    ) -> Result<SshChannel> {
        let channel = self
            .inner
            .open_direct_tcpip(&host, port, &origin_host, origin_port)
            .await?;
        Ok(SshChannel::new(ChannelCore::start(channel)))
    }

    /// A channel to `host:port` for another connection to run over (`ssh -W`).
    #[napi]
    pub async fn open_tunnel(&self, host: String, port: u32) -> Result<SshTunnel> {
        let channel = self
            .inner
            .open_direct_tcpip(&host, port, "127.0.0.1", 0)
            .await?;
        Ok(SshTunnel {
            channel: Mutex::new(Some(channel)),
        })
    }

    /// Start the SFTP subsystem on a channel of its own.
    #[napi]
    pub async fn open_sftp(&self) -> Result<SftpSession> {
        let mut channel = self.inner.open_session_channel().await?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(from_russh)?;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => break,
                Some(ChannelMsg::Failure) => {
                    let _ = channel.close().await;
                    return Err(coded(
                        "SUBSYSTEM_REFUSED",
                        "Unable to start subsystem: sftp",
                    ));
                }
                Some(ChannelMsg::Close) | None => return Err(disconnected()),
                Some(_) => {}
            }
        }
        SftpSession::start(channel.into_stream(), None).await
    }
}

impl SshClient {
    pub(crate) fn inner(&self) -> &Arc<ClientInner> {
        &self.inner
    }
}
