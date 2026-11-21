//! ssh-agent requests, each over a connection of its own: an agent that accepts a connection
//! and never answers costs that one request, not the login waiting on it.

use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::coded;
use crate::stream::connect_local;

const FAILURE: u8 = 5;
const REQUEST_IDENTITIES: u8 = 11;
const IDENTITIES_ANSWER: u8 = 12;
const SIGN_REQUEST: u8 = 13;
const SIGN_RESPONSE: u8 = 14;

/// Agents answer with a handful of keys; this only keeps a confused peer from filling memory.
const MAX_REPLY: usize = 4 * 1024 * 1024;

/// One identity an agent holds: a public key or a certificate in SSH wire format.
#[napi(object)]
pub struct AgentIdentity {
    pub blob: Buffer,
    pub comment: String,
}

fn put_string(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value);
}

/// Reads one length-prefixed field and returns the rest.
fn take_string(input: &[u8]) -> Option<(&[u8], &[u8])> {
    let length = u32::from_be_bytes(input.get(..4)?.try_into().ok()?) as usize;
    let value = input.get(4..4 + length)?;
    Some((value, &input[4 + length..]))
}

fn protocol_error() -> Error {
    coded(
        "AGENT_PROTOCOL",
        "the SSH agent sent a reply that makes no sense",
    )
}

async fn exchange(endpoint: &str, request: Vec<u8>) -> Result<Vec<u8>> {
    let mut stream = connect_local(endpoint).await.map_err(|err| {
        coded(
            "AGENT_UNAVAILABLE",
            format!("Failed to connect to SSH agent: {err}"),
        )
    })?;
    let closed = |_| {
        coded(
            "AGENT_CLOSED",
            "SSH agent connection closed before replying",
        )
    };
    let mut frame = Vec::with_capacity(request.len() + 4);
    put_string(&mut frame, &request);
    stream.write_all(&frame).await.map_err(closed)?;
    stream.flush().await.map_err(closed)?;
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await.map_err(closed)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_REPLY {
        return Err(protocol_error());
    }
    let mut reply = vec![0u8; length];
    stream.read_exact(&mut reply).await.map_err(closed)?;
    Ok(reply)
}

async fn within<T>(
    timeout_ms: u32,
    what: &str,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    if timeout_ms == 0 {
        return work.await;
    }
    match tokio::time::timeout(Duration::from_millis(timeout_ms as u64), work).await {
        Ok(result) => result,
        Err(_) => Err(coded(
            "AGENT_TIMEOUT",
            format!("SSH agent did not respond while {what}"),
        )),
    }
}

/// The identities the agent at `endpoint` holds. `timeoutMs` 0 waits as long as the agent does.
#[napi]
pub async fn agent_identities(endpoint: String, timeout_ms: u32) -> Result<Vec<AgentIdentity>> {
    within(timeout_ms, "listing identities", async {
        let reply = exchange(&endpoint, vec![REQUEST_IDENTITIES]).await?;
        let (&kind, mut rest) = reply.split_first().ok_or_else(protocol_error)?;
        if kind == FAILURE {
            return Err(coded("AGENT_FAILURE", "Agent responded with failure"));
        }
        if kind != IDENTITIES_ANSWER {
            return Err(protocol_error());
        }
        let count = u32::from_be_bytes(
            rest.get(..4)
                .and_then(|b| b.try_into().ok())
                .ok_or_else(protocol_error)?,
        );
        rest = &rest[4..];
        let mut identities = Vec::new();
        for _ in 0..count {
            let (blob, after_blob) = take_string(rest).ok_or_else(protocol_error)?;
            let (comment, after_comment) = take_string(after_blob).ok_or_else(protocol_error)?;
            identities.push(AgentIdentity {
                blob: Buffer::from(blob.to_vec()),
                comment: String::from_utf8_lossy(comment).into_owned(),
            });
            rest = after_comment;
        }
        Ok(identities)
    })
    .await
}

/// Ask the agent to sign `data` with the identity `blob`. `flags` are the agent protocol's
/// (2 and 4 pick rsa-sha2-256 and rsa-sha2-512). Resolves with the SSH signature blob, which for
/// a security key carries its flags and counter after the signature.
#[napi]
pub async fn agent_sign(
    endpoint: String,
    blob: Buffer,
    data: Buffer,
    flags: u32,
    timeout_ms: u32,
) -> Result<Buffer> {
    let mut request = vec![SIGN_REQUEST];
    put_string(&mut request, &blob);
    put_string(&mut request, &data);
    request.extend_from_slice(&flags.to_be_bytes());
    within(timeout_ms, "signing", async {
        let reply = exchange(&endpoint, request).await?;
        let (&kind, rest) = reply.split_first().ok_or_else(protocol_error)?;
        if kind == FAILURE {
            return Err(coded("AGENT_FAILURE", "Agent responded with failure"));
        }
        if kind != SIGN_RESPONSE {
            return Err(protocol_error());
        }
        let (signature, _) = take_string(rest).ok_or_else(protocol_error)?;
        Ok(Buffer::from(signature.to_vec()))
    })
    .await
}
