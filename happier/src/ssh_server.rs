use std::io::{Read, Write};
use std::sync::Arc;

use async_trait::async_trait;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use russh::server::{Auth, Handler, Msg, Session};
use russh::{Channel, ChannelId, CryptoVec, Pty};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

/// Start a built-in SSH server on an arbitrary async stream.
/// The stream is typically one end of a `tokio::io::duplex()` pair,
/// with the other end wired to the tunnel transport.
pub async fn serve<S>(stream: S, data_dir: &str)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let key = load_or_generate_host_key(data_dir);
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: std::time::Duration::from_secs(0),
        auth_rejection_time_initial: Some(std::time::Duration::from_secs(0)),
        ..Default::default()
    });

    let handler = SshHandler {
        pty_master: None,
        pty_writer: None,
        channel_id: None,
    };

    match russh::server::run_stream(config, stream, handler).await {
        Ok(session) => {
            if let Err(e) = session.await {
                log::debug!("SSH session ended: {e}");
            }
        }
        Err(e) => {
            log::warn!("SSH session setup error: {e}");
        }
    }
}

fn load_or_generate_host_key(data_dir: &str) -> russh_keys::key::KeyPair {
    let key_path = std::path::Path::new(data_dir).join("ssh_host_key");

    // Try loading existing key
    if key_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&key_path) {
            if let Ok(key) = russh_keys::decode_secret_key(&contents, None) {
                log::info!("Loaded SSH host key from {}", key_path.display());
                return key;
            }
        }
        log::warn!("Failed to load host key, generating new one");
    }

    // Generate new Ed25519 key
    let key = russh_keys::key::KeyPair::generate_ed25519();

    // Persist it
    if let Some(parent) = key_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut buf = Vec::new();
    match russh_keys::encode_pkcs8_pem(&key, &mut buf) {
        Ok(_) => match std::fs::write(&key_path, &buf) {
            Ok(_) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        &key_path,
                        std::fs::Permissions::from_mode(0o600),
                    );
                }
                log::info!("Generated SSH host key at {}", key_path.display());
            }
            Err(e) => log::warn!("Failed to save host key: {e}"),
        },
        Err(e) => log::warn!("Failed to encode host key: {e}"),
    }
    key
}

struct SshHandler {
    pty_master: Option<Box<dyn MasterPty + Send>>,
    pty_writer: Option<Box<dyn Write + Send>>,
    channel_id: Option<ChannelId>,
}

#[async_trait]
impl Handler for SshHandler {
    type Error = russh::Error;

    // Accept all auth — tunnel is already authenticated at the hub level
    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh_keys::key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: row_height as u16,
                cols: col_width as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| russh::Error::IO(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| russh::Error::IO(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| russh::Error::IO(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        self.pty_master = Some(pair.master);
        self.pty_writer = Some(writer);
        self.channel_id = Some(channel);

        // Spawn the shell on the slave side
        let mut cmd = CommandBuilder::new_default_prog();
        cmd.env("TERM", term);
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| russh::Error::IO(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        // Thread: read from PTY (blocking) → send to async channel
        let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(64);
        std::thread::spawn(move || {
            pty_read_loop(reader, output_tx);
        });

        // Task: drain output_rx → SSH channel data
        let session_handle = session.handle();
        tokio::spawn(async move {
            while let Some(data) = output_rx.recv().await {
                let _ = session_handle
                    .data(channel, CryptoVec::from_slice(&data))
                    .await;
            }
            // PTY closed — send EOF + exit status + close
            let exit_code = match child.try_wait() {
                Ok(Some(status)) => status.exit_code(),
                _ => match child.wait() {
                    Ok(status) => status.exit_code(),
                    Err(_) => 1,
                },
            };
            let _ = session_handle.eof(channel).await;
            let _ = session_handle
                .exit_status_request(channel, exit_code)
                .await;
            let _ = session_handle.close(channel).await;
        });

        session.channel_success(channel);
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // PTY was already requested (pty_request called first), shell is already running.
        session.channel_success(channel);
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).to_string();

        // If no PTY was requested, run command without PTY
        if self.pty_master.is_none() {
            let session_handle = session.handle();
            tokio::spawn(async move {
                exec_no_pty(channel, &command, session_handle).await;
            });
            session.channel_success(channel);
            return Ok(());
        }

        // PTY exists — write command to it
        if let Some(ref mut writer) = self.pty_writer {
            let _ = writer.write_all(command.as_bytes());
            let _ = writer.write_all(b"\n");
        }
        session.channel_success(channel);
        Ok(())
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(ref mut writer) = self.pty_writer {
            let _ = writer.write_all(data);
            let _ = writer.flush();
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(ref master) = self.pty_master {
            let _ = master.resize(PtySize {
                rows: row_height as u16,
                cols: col_width as u16,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.pty_writer.take();
        Ok(())
    }
}

fn pty_read_loop(mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<Vec<u8>>) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx.blocking_send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

async fn exec_no_pty(channel: ChannelId, command: &str, session: russh::server::Handle) {
    #[cfg(unix)]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    #[cfg(windows)]
    let shell = "cmd.exe".to_string();

    #[cfg(unix)]
    let output = tokio::process::Command::new(&shell)
        .arg("-c")
        .arg(command)
        .output()
        .await;

    #[cfg(windows)]
    let output = tokio::process::Command::new(&shell)
        .arg("/C")
        .arg(command)
        .output()
        .await;

    match output {
        Ok(out) => {
            if !out.stdout.is_empty() {
                let _ = session
                    .data(channel, CryptoVec::from_slice(&out.stdout))
                    .await;
            }
            if !out.stderr.is_empty() {
                let _ = session
                    .extended_data(channel, 1, CryptoVec::from_slice(&out.stderr))
                    .await;
            }
            let code = out.status.code().unwrap_or(1) as u32;
            let _ = session.eof(channel).await;
            let _ = session.exit_status_request(channel, code).await;
            let _ = session.close(channel).await;
        }
        Err(e) => {
            let msg = format!("Failed to execute command: {e}\n");
            let _ = session
                .extended_data(channel, 1, CryptoVec::from_slice(msg.as_bytes()))
                .await;
            let _ = session.eof(channel).await;
            let _ = session.exit_status_request(channel, 1).await;
            let _ = session.close(channel).await;
        }
    }
}
