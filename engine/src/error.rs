//! Errors cross to JavaScript as `[CODE] message`, or `[CODE#detail] message` when a number
//! belongs to the failure (an SFTP status, a channel-open reason). The TypeScript side turns the
//! prefix into `error.code` and `error.detail`, so callers branch on codes instead of wording.

use napi::{Error, Status};

pub fn coded(code: &str, message: impl AsRef<str>) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("[{code}] {}", message.as_ref()),
    )
}

pub fn coded_detail(code: &str, detail: u32, message: impl AsRef<str>) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("[{code}#{detail}] {}", message.as_ref()),
    )
}

/// The errno name Node would have reported for the same failure.
pub fn io_code(err: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::ConnectionRefused => "ECONNREFUSED",
        ErrorKind::ConnectionReset => "ECONNRESET",
        ErrorKind::ConnectionAborted => "ECONNABORTED",
        ErrorKind::TimedOut => "ETIMEDOUT",
        ErrorKind::HostUnreachable => "EHOSTUNREACH",
        ErrorKind::NetworkUnreachable => "ENETUNREACH",
        ErrorKind::BrokenPipe => "EPIPE",
        ErrorKind::AddrInUse => "EADDRINUSE",
        ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
        ErrorKind::PermissionDenied => "EACCES",
        ErrorKind::NotFound => "ENOENT",
        ErrorKind::UnexpectedEof => "ECONNRESET",
        _ => "EIO",
    }
}

pub fn io_error(err: &std::io::Error) -> Error {
    coded(io_code(err), err.to_string())
}

/// The session is gone: every request on it fails the same way.
pub fn disconnected() -> Error {
    coded("DISCONNECTED", "Not connected")
}

pub fn from_russh(err: russh::Error) -> Error {
    match err {
        russh::Error::ChannelOpenFailure(reason) => channel_open_failure(&reason),
        russh::Error::IO(io) => io_error(&io),
        russh::Error::SendError | russh::Error::Disconnect | russh::Error::HUP => disconnected(),
        russh::Error::KeepaliveTimeout => coded("KEEPALIVE_TIMEOUT", "Keepalive timeout"),
        other => coded("PROTOCOL", other.to_string()),
    }
}

pub fn channel_open_failure(reason: &russh::ChannelOpenFailure) -> Error {
    use russh::ChannelOpenFailure as F;
    let (code, text) = match reason {
        F::AdministrativelyProhibited => (1, "administratively prohibited".to_string()),
        F::ConnectFailed => (2, "connect failed".to_string()),
        F::UnknownChannelType => (3, "unknown channel type".to_string()),
        F::ResourceShortage => (4, "resource shortage".to_string()),
        F::Other { code, reason } => (*code, reason.clone()),
    };
    coded_detail(
        "CHANNEL_OPEN_FAILED",
        code,
        format!("Channel open failure: {text}"),
    )
}
