//! ProxyCommand: the user's shell runs the command, and its stdin and stdout carry the SSH
//! session, as with OpenSSH. Pipes and quoted arguments mean what they mean in that shell.

use std::io;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const STDERR_LIMIT: usize = 8 * 1024;

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        // The command line goes to cmd.exe as written; Rust's own quoting would escape quotes
        // in a way cmd does not undo.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut cmd = Command::new(shell);
        cmd.raw_arg(format!("/d /s /c \"{command}\""));
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(command);
        cmd
    }
}

pub struct ProxyCommand {
    stdout: ChildStdout,
    stdin: ChildStdin,
    status: ProxyStatus,
}

/// How the command ended, readable after its stream has been handed to the SSH session.
#[derive(Clone)]
pub struct ProxyStatus {
    child: Arc<Mutex<Child>>,
    stderr: Arc<Mutex<String>>,
    stderr_closed: Arc<AtomicBool>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl ProxyCommand {
    pub fn spawn(command: &str) -> io::Result<Self> {
        let mut child = shell_command(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let missing = || io::Error::other("the command has no standard streams");
        let stdout = child.stdout.take().ok_or_else(missing)?;
        let stdin = child.stdin.take().ok_or_else(missing)?;
        let stderr_pipe = child.stderr.take();
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_closed = Arc::new(AtomicBool::new(stderr_pipe.is_none()));
        if let Some(mut pipe) = stderr_pipe {
            let sink = stderr.clone();
            let closed = stderr_closed.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = pipe.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let mut text = lock(&sink);
                    text.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if text.len() > STDERR_LIMIT {
                        let cut = text.len() - STDERR_LIMIT;
                        let cut = (cut..text.len())
                            .find(|i| text.is_char_boundary(*i))
                            .unwrap_or(text.len());
                        text.drain(..cut);
                    }
                }
                closed.store(true, Ordering::SeqCst);
            });
        }
        Ok(Self {
            stdout,
            stdin,
            status: ProxyStatus {
                child: Arc::new(Mutex::new(child)),
                stderr,
                stderr_closed,
            },
        })
    }

    pub fn status(&self) -> ProxyStatus {
        self.status.clone()
    }
}

impl ProxyStatus {
    /// Wait up to `wait` for the command to exit; its failure message when it failed.
    pub async fn failure(&self, wait: Duration) -> Option<String> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let exited = lock(&self.child).try_wait().ok().flatten().is_some();
            let late = tokio::time::Instant::now() >= deadline;
            // The command's last words can still be in the pipe when it exits, and they are
            // what explains the failure.
            if exited && (late || self.stderr_closed.load(Ordering::SeqCst)) {
                return self.exit_message();
            }
            if late {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn exit_message(&self) -> Option<String> {
        let status = lock(&self.child).try_wait().ok().flatten()?;
        if status.success() {
            return None;
        }
        let reason = match status.code() {
            Some(code) => format!("exit code {code}"),
            None => "a signal".to_string(),
        };
        let detail = lock(&self.stderr).trim().to_string();
        Some(if detail.is_empty() {
            format!("ProxyCommand failed with {reason}")
        } else {
            format!("ProxyCommand failed with {reason}: {detail}")
        })
    }
}

impl AsyncRead for ProxyCommand {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.stdout).poll_read(cx, buf) {
            // The end of its output is the command's exit; say why when it failed.
            Poll::Ready(Ok(())) if buf.filled().len() == before => {
                match self.status.exit_message() {
                    Some(message) => Poll::Ready(Err(io::Error::other(message))),
                    None => Poll::Ready(Ok(())),
                }
            }
            other => other,
        }
    }
}

impl AsyncWrite for ProxyCommand {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}
