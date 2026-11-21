//! The SSH engine of Muxus as a Node addon: transport, login steps, channels, SFTP and port
//! forwards on russh. It carries bytes and speaks the protocol; what to trust, which login
//! method to try and what to ask the user is decided by the TypeScript that drives it.

#![cfg_attr(test, allow(dead_code, unused_imports))]

mod agent;
mod algorithms;
mod channel;
mod client;
mod error;
mod forward;
mod keys;
mod local;
mod proxy;
mod rt;
mod sftp;
mod stream;
#[cfg(test)]
mod test_host;
