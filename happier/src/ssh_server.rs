use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use russh::server::{Auth, Handler, Msg, Session};
use russh::{Channel, ChannelId, CryptoVec, Pty};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
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
        channels: HashMap::new(),
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

// ── Channel lifecycle helpers ──────────────────────────────────────────

/// Send the standard channel close sequence: exit-status → EOF → close.
/// This follows the SSH protocol ordering (RFC 4254 §6.10):
///   server sends exit-status, then EOF, then close.
async fn close_channel(session: &russh::server::Handle, channel: ChannelId, exit_code: u32) {
    if let Err(e) = session.exit_status_request(channel, exit_code).await {
        log::debug!("Channel {channel:?}: failed to send exit-status: {e:?}");
    }
    if let Err(e) = session.eof(channel).await {
        log::debug!("Channel {channel:?}: failed to send EOF: {e:?}");
    }
    if let Err(e) = session.close(channel).await {
        log::debug!("Channel {channel:?}: failed to close: {e:?}");
    }
}

// ── Host key management ────────────────────────────────────────────────

fn load_or_generate_host_key(data_dir: &str) -> russh::keys::PrivateKey {
    let key_path = std::path::Path::new(data_dir).join("ssh_host_key");

    if key_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&key_path) {
            if let Ok(key) = russh::keys::decode_secret_key(&contents, None) {
                log::info!("Loaded SSH host key from {}", key_path.display());
                return key;
            }
        }
        log::warn!("Failed to load host key, generating new one");
    }

    let key = match russh::keys::PrivateKey::random(
        &mut russh::keys::ssh_key::rand_core::OsRng,
        russh::keys::Algorithm::Ed25519,
    ) {
        Ok(k) => k,
        Err(e) => {
            log::error!("Failed to generate Ed25519 host key: {e}");
            panic!("Cannot start SSH server without a host key");
        }
    };

    if let Some(parent) = key_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("Failed to create host key directory: {e}");
        }
    }
    let mut buf = Vec::new();
    match russh::keys::encode_pkcs8_pem(&key, &mut buf) {
        Ok(()) => match std::fs::write(&key_path, &buf) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Err(e) =
                        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
                    {
                        log::warn!("Failed to set host key permissions: {e}");
                    }
                }
                log::info!("Generated SSH host key at {}", key_path.display());
            }
            Err(e) => log::warn!("Failed to save host key: {e}"),
        },
        Err(e) => log::warn!("Failed to encode host key: {e}"),
    }
    key
}

// ── SSH Handler ────────────────────────────────────────────────────────

struct SshHandler {
    pty_master: Option<Box<dyn MasterPty + Send>>,
    pty_writer: Option<Box<dyn Write + Send>>,
    channels: HashMap<ChannelId, Channel<Msg>>,
}

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
        _key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        self.channels.insert(channel.id(), channel);
        async { Ok(true) }
    }

    fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let pty_system = native_pty_system();
        let result = pty_system.openpty(PtySize {
            rows: row_height as u16,
            cols: col_width as u16,
            pixel_width: 0,
            pixel_height: 0,
        });

        let pair = match result {
            Ok(p) => p,
            Err(e) => {
                log::warn!("PTY open failed: {e}");
                session.channel_failure(channel).ok();
                return std::future::ready(Err(russh::Error::IO(std::io::Error::other(e))));
            }
        };

        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                log::warn!("PTY take_writer failed: {e}");
                session.channel_failure(channel).ok();
                return std::future::ready(Err(russh::Error::IO(std::io::Error::other(e))));
            }
        };

        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                log::warn!("PTY clone_reader failed: {e}");
                session.channel_failure(channel).ok();
                return std::future::ready(Err(russh::Error::IO(std::io::Error::other(e))));
            }
        };

        self.pty_master = Some(pair.master);
        self.pty_writer = Some(writer);

        let mut cmd = CommandBuilder::new_default_prog();
        cmd.env("TERM", term);
        let child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Shell spawn failed: {e}");
                session.channel_failure(channel).ok();
                return std::future::ready(Err(russh::Error::IO(std::io::Error::other(e))));
            }
        };

        // Thread: read from PTY (blocking) → async channel
        let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(64);
        std::thread::spawn(move || {
            pty_read_loop(reader, output_tx);
        });

        // Task: drain output → SSH channel, then close
        let session_handle = session.handle();
        tokio::spawn(async move {
            pty_output_loop(channel, child, &mut output_rx, session_handle).await;
        });

        if let Err(e) = session.channel_success(channel) {
            log::debug!("Channel {channel:?}: channel_success failed: {e}");
        }
        std::future::ready(Ok(()))
    }

    fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        if let Err(e) = session.channel_success(channel) {
            log::debug!("Channel {channel:?}: channel_success failed: {e}");
        }
        async { Ok(()) }
    }

    fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let command = String::from_utf8_lossy(data).to_string();

        if self.pty_master.is_none() {
            // No PTY — run command and capture output
            let session_handle = session.handle();
            tokio::spawn(async move {
                exec_no_pty(channel, &command, session_handle).await;
            });
            if let Err(e) = session.channel_success(channel) {
                log::debug!("Channel {channel:?}: channel_success failed: {e}");
            }
            return std::future::ready(Ok(()));
        }

        // PTY exists — write command to it
        if let Some(ref mut writer) = self.pty_writer {
            if let Err(e) = writer.write_all(command.as_bytes()) {
                log::warn!("PTY write error: {e}");
            } else if let Err(e) = writer.write_all(b"\n") {
                log::warn!("PTY write error: {e}");
            }
        }
        if let Err(e) = session.channel_success(channel) {
            log::debug!("Channel {channel:?}: channel_success failed: {e}");
        }
        std::future::ready(Ok(()))
    }

    fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        if name == "sftp" {
            if let Some(channel) = self.channels.remove(&channel_id) {
                log::info!("SFTP subsystem starting on channel {channel_id:?}");
                if let Err(e) = session.channel_success(channel_id) {
                    log::warn!("Channel {channel_id:?}: channel_success failed: {e}");
                }
                let session_handle = session.handle();
                tokio::spawn(async move {
                    russh_sftp::server::run(channel.into_stream(), SftpHandler::new()).await;
                    log::info!("SFTP subsystem ended on channel {channel_id:?}");
                    // SFTP done — send exit-status only.
                    // The client will send EOF+close to tear down the channel.
                    if let Err(e) = session_handle.exit_status_request(channel_id, 0).await {
                        log::debug!("Channel {channel_id:?}: failed to send exit-status: {e:?}");
                    }
                });
            } else {
                log::warn!("SFTP: no channel for {channel_id:?}");
                if let Err(e) = session.channel_failure(channel_id) {
                    log::debug!("Channel {channel_id:?}: channel_failure failed: {e}");
                }
            }
        } else {
            log::debug!("Unsupported subsystem: {name}");
            if let Err(e) = session.channel_failure(channel_id) {
                log::debug!("Channel {channel_id:?}: channel_failure failed: {e}");
            }
        }
        async { Ok(()) }
    }

    fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        if let Some(ref mut writer) = self.pty_writer {
            if let Err(e) = writer.write_all(data) {
                log::debug!("Channel {channel:?}: PTY write error: {e}");
            } else if let Err(e) = writer.flush() {
                log::debug!("Channel {channel:?}: PTY flush error: {e}");
            }
        }
        async { Ok(()) }
    }

    fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        if let Some(ref master) = self.pty_master {
            if let Err(e) = master.resize(PtySize {
                rows: row_height as u16,
                cols: col_width as u16,
                pixel_width: 0,
                pixel_height: 0,
            }) {
                log::debug!("Channel {channel:?}: PTY resize error: {e}");
            }
        }
        async { Ok(()) }
    }

    fn channel_eof(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        log::debug!("Channel {channel:?}: received EOF from client");
        // Close PTY stdin so the shell sees EOF and exits naturally
        self.pty_writer.take();
        // SFTP channels: the russh_sftp stream will see EOF on its read side,
        // causing russh_sftp::server::run() to return.
        async { Ok(()) }
    }
}

// ── PTY helpers ────────────────────────────────────────────────────────

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
            Err(e) => {
                log::debug!("PTY read error: {e}");
                break;
            }
        }
    }
}

async fn pty_output_loop(
    channel: ChannelId,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    output_rx: &mut mpsc::Receiver<Vec<u8>>,
    session: russh::server::Handle,
) {
    while let Some(data) = output_rx.recv().await {
        if let Err(e) = session
            .data(channel, CryptoVec::from_slice(&data))
            .await
        {
            log::debug!("Channel {channel:?}: data send failed: {e:?}");
            break;
        }
    }

    // PTY output ended — collect exit code and close channel
    let exit_code = match child.try_wait() {
        Ok(Some(status)) => status.exit_code(),
        _ => match child.wait() {
            Ok(status) => status.exit_code(),
            Err(e) => {
                log::debug!("Channel {channel:?}: wait for child failed: {e}");
                1
            }
        },
    };
    close_channel(&session, channel, exit_code).await;
}

// ── Non-PTY exec ───────────────────────────────────────────────────────

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
                if let Err(e) = session
                    .data(channel, CryptoVec::from_slice(&out.stdout))
                    .await
                {
                    log::debug!("Channel {channel:?}: stdout send failed: {e:?}");
                }
            }
            if !out.stderr.is_empty() {
                if let Err(e) = session
                    .extended_data(channel, 1, CryptoVec::from_slice(&out.stderr))
                    .await
                {
                    log::debug!("Channel {channel:?}: stderr send failed: {e:?}");
                }
            }
            let code = out.status.code().unwrap_or(1) as u32;
            close_channel(&session, channel, code).await;
        }
        Err(e) => {
            let msg = format!("Failed to execute command: {e}\n");
            if let Err(e) = session
                .extended_data(channel, 1, CryptoVec::from_slice(msg.as_bytes()))
                .await
            {
                log::debug!("Channel {channel:?}: error send failed: {e:?}");
            }
            close_channel(&session, channel, 1).await;
        }
    }
}

// ── SFTP Handler ───────────────────────────────────────────────────────

struct SftpHandler {
    handles: HashMap<String, SftpHandle>,
    next_handle: u64,
}

enum SftpHandle {
    File(std::fs::File),
    Dir(Vec<File>),
}

impl SftpHandler {
    fn new() -> Self {
        Self {
            handles: HashMap::new(),
            next_handle: 0,
        }
    }

    fn alloc_handle(&mut self, h: SftpHandle) -> String {
        let id = self.next_handle;
        self.next_handle += 1;
        let name = format!("h{id}");
        self.handles.insert(name.clone(), h);
        name
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".into(),
        language_tag: "en-US".into(),
    }
}

#[cfg(unix)]
fn file_attrs_from_metadata(meta: &std::fs::Metadata) -> FileAttributes {
    use std::os::unix::fs::MetadataExt;
    FileAttributes {
        size: Some(meta.len()),
        uid: Some(meta.uid()),
        user: None,
        gid: Some(meta.gid()),
        group: None,
        permissions: Some(meta.mode()),
        atime: Some(meta.atime() as u32),
        mtime: Some(meta.mtime() as u32),
    }
}

#[cfg(not(unix))]
fn file_attrs_from_metadata(meta: &std::fs::Metadata) -> FileAttributes {
    FileAttributes {
        size: Some(meta.len()),
        uid: None,
        user: None,
        gid: None,
        group: None,
        permissions: None,
        atime: None,
        mtime: None,
    }
}

impl russh_sftp::server::Handler for SftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    fn realpath(
        &mut self,
        id: u32,
        path: String,
    ) -> impl std::future::Future<Output = Result<Name, Self::Error>> + Send {
        let resolved = std::fs::canonicalize(&path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        async move {
            Ok(Name {
                id,
                files: vec![File::dummy(&resolved)],
            })
        }
    }

    fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> impl std::future::Future<Output = Result<Attrs, Self::Error>> + Send {
        let result = std::fs::metadata(&path);
        async move {
            match result {
                Ok(meta) => Ok(Attrs { id, attrs: file_attrs_from_metadata(&meta) }),
                Err(_) => Err(StatusCode::NoSuchFile),
            }
        }
    }

    fn lstat(
        &mut self,
        id: u32,
        path: String,
    ) -> impl std::future::Future<Output = Result<Attrs, Self::Error>> + Send {
        let result = std::fs::symlink_metadata(&path);
        async move {
            match result {
                Ok(meta) => Ok(Attrs { id, attrs: file_attrs_from_metadata(&meta) }),
                Err(_) => Err(StatusCode::NoSuchFile),
            }
        }
    }

    fn opendir(
        &mut self,
        id: u32,
        path: String,
    ) -> impl std::future::Future<Output = Result<Handle, Self::Error>> + Send {
        let canonical = std::fs::canonicalize(&path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);

        let handle = match std::fs::read_dir(&canonical) {
            Ok(entries) => {
                let mut files = vec![File::dummy("."), File::dummy("..")];
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let attrs = entry
                        .metadata()
                        .map(|m| file_attrs_from_metadata(&m))
                        .unwrap_or_default();
                    files.push(File::new(&name, attrs));
                }
                Some(self.alloc_handle(SftpHandle::Dir(files)))
            }
            Err(_) => None,
        };
        async move {
            match handle {
                Some(h) => Ok(Handle { id, handle: h }),
                None => Err(StatusCode::NoSuchFile),
            }
        }
    }

    fn readdir(
        &mut self,
        id: u32,
        handle: String,
    ) -> impl std::future::Future<Output = Result<Name, Self::Error>> + Send {
        const BATCH_SIZE: usize = 100;
        let result = if let Some(SftpHandle::Dir(ref mut entries)) = self.handles.get_mut(&handle) {
            if entries.is_empty() {
                Err(StatusCode::Eof)
            } else {
                let batch: Vec<File> = entries.drain(..entries.len().min(BATCH_SIZE)).collect();
                Ok(Name { id, files: batch })
            }
        } else {
            Err(StatusCode::Failure)
        };
        async move { result }
    }

    fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> impl std::future::Future<Output = Result<Handle, Self::Error>> + Send {
        let mut opts = std::fs::OpenOptions::new();
        if pflags.contains(OpenFlags::READ) { opts.read(true); }
        if pflags.contains(OpenFlags::WRITE) { opts.write(true); }
        if pflags.contains(OpenFlags::APPEND) { opts.append(true); }
        if pflags.contains(OpenFlags::CREATE) { opts.create(true); }
        if pflags.contains(OpenFlags::TRUNCATE) { opts.truncate(true); }
        if pflags.contains(OpenFlags::EXCLUDE) { opts.create_new(true); }

        let handle = match opts.open(&filename) {
            Ok(f) => Some(self.alloc_handle(SftpHandle::File(f))),
            Err(_) => None,
        };
        async move {
            match handle {
                Some(h) => Ok(Handle { id, handle: h }),
                None => Err(StatusCode::NoSuchFile),
            }
        }
    }

    fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> impl std::future::Future<Output = Result<Data, Self::Error>> + Send {
        use std::io::{Read as _, Seek, SeekFrom};
        let result = if let Some(SftpHandle::File(ref mut f)) = self.handles.get_mut(&handle) {
            if f.seek(SeekFrom::Start(offset)).is_err() {
                Err(StatusCode::Failure)
            } else {
                let mut buf = vec![0u8; len as usize];
                match f.read(&mut buf) {
                    Ok(0) => Err(StatusCode::Eof),
                    Ok(n) => { buf.truncate(n); Ok(Data { id, data: buf }) }
                    Err(_) => Err(StatusCode::Failure),
                }
            }
        } else {
            Err(StatusCode::Failure)
        };
        async move { result }
    }

    fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<Status, Self::Error>> + Send {
        use std::io::{Seek, SeekFrom, Write as _};
        let result = if let Some(SftpHandle::File(ref mut f)) = self.handles.get_mut(&handle) {
            if f.seek(SeekFrom::Start(offset)).is_err() {
                Err(StatusCode::Failure)
            } else {
                match f.write_all(&data) {
                    Ok(()) => Ok(ok_status(id)),
                    Err(_) => Err(StatusCode::Failure),
                }
            }
        } else {
            Err(StatusCode::Failure)
        };
        async move { result }
    }

    fn fstat(
        &mut self,
        id: u32,
        handle: String,
    ) -> impl std::future::Future<Output = Result<Attrs, Self::Error>> + Send {
        let result = if let Some(SftpHandle::File(ref f)) = self.handles.get(&handle) {
            match f.metadata() {
                Ok(meta) => Ok(Attrs { id, attrs: file_attrs_from_metadata(&meta) }),
                Err(_) => Err(StatusCode::Failure),
            }
        } else {
            Err(StatusCode::Failure)
        };
        async move { result }
    }

    fn close(
        &mut self,
        id: u32,
        handle: String,
    ) -> impl std::future::Future<Output = Result<Status, Self::Error>> + Send {
        self.handles.remove(&handle);
        async move { Ok(ok_status(id)) }
    }

    fn remove(
        &mut self,
        id: u32,
        filename: String,
    ) -> impl std::future::Future<Output = Result<Status, Self::Error>> + Send {
        let result = std::fs::remove_file(&filename);
        async move {
            match result {
                Ok(()) => Ok(ok_status(id)),
                Err(_) => Err(StatusCode::NoSuchFile),
            }
        }
    }

    fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> impl std::future::Future<Output = Result<Status, Self::Error>> + Send {
        let result = std::fs::create_dir(&path);
        async move {
            match result {
                Ok(()) => Ok(ok_status(id)),
                Err(_) => Err(StatusCode::Failure),
            }
        }
    }

    fn rmdir(
        &mut self,
        id: u32,
        path: String,
    ) -> impl std::future::Future<Output = Result<Status, Self::Error>> + Send {
        let result = std::fs::remove_dir(&path);
        async move {
            match result {
                Ok(()) => Ok(ok_status(id)),
                Err(_) => Err(StatusCode::Failure),
            }
        }
    }

    fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> impl std::future::Future<Output = Result<Status, Self::Error>> + Send {
        let result = std::fs::rename(&oldpath, &newpath);
        async move {
            match result {
                Ok(()) => Ok(ok_status(id)),
                Err(_) => Err(StatusCode::Failure),
            }
        }
    }

    fn readlink(
        &mut self,
        id: u32,
        path: String,
    ) -> impl std::future::Future<Output = Result<Name, Self::Error>> + Send {
        let result = std::fs::read_link(&path);
        async move {
            match result {
                Ok(target) => Ok(Name {
                    id,
                    files: vec![File::dummy(target.to_string_lossy().to_string())],
                }),
                Err(_) => Err(StatusCode::NoSuchFile),
            }
        }
    }

    fn symlink(
        &mut self,
        id: u32,
        linkpath: String,
        targetpath: String,
    ) -> impl std::future::Future<Output = Result<Status, Self::Error>> + Send {
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(&targetpath, &linkpath)
            .map(|()| ok_status(id))
            .map_err(|_| StatusCode::Failure);
        #[cfg(not(unix))]
        let result: Result<Status, StatusCode> = Err(StatusCode::OpUnsupported);
        async move { result }
    }

    async fn setstat(
        &mut self,
        id: u32,
        _path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(ok_status(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        _handle: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(ok_status(id))
    }
}
