use super::web::{Execution, execute};
use crate::output::CappedOutput;
use crate::{
    DeterminismConfig, ExecutionTermination, InteractiveMetrics, InteractiveProcessResult,
    InteractiveProgram, RunError, RunRequest,
};
use serde::{Deserialize, Serialize};
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use virtual_fs::{FsError, VirtualFile};
use wasm_bindgen::JsValue;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InteractiveSideRequest {
    pub program: InteractiveProgram,
    pub determinism: DeterminismConfig,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveSideResult {
    pub process: InteractiveProcessResult,
    #[serde(with = "serde_bytes")]
    pub protocol: Vec<u8>,
}

/// Blocking stream callbacks supplied by the side Worker. They wait with
/// `Atomics.wait`, so reads and writes never return `Pending` to WASIX.
pub struct HostStreams {
    read: js_sys::Function,
    wait: js_sys::Function,
    write: js_sys::Function,
}

// SAFETY: the web build of runtime-core has no threads; these JS handles never
// leave the Worker thread that created them.
unsafe impl Send for HostStreams {}
// SAFETY: see `Send`.
unsafe impl Sync for HostStreams {}

impl HostStreams {
    pub fn new(read: js_sys::Function, wait: js_sys::Function, write: js_sys::Function) -> Self {
        Self { read, wait, write }
    }

    fn read(&self, maximum: usize) -> io::Result<Vec<u8>> {
        let chunk = self
            .read
            .call1(&JsValue::UNDEFINED, &JsValue::from(maximum as u32))
            .map_err(host_error)?;
        Ok(js_sys::Uint8Array::new(&chunk).to_vec())
    }

    fn wait(&self) -> io::Result<usize> {
        let available = self
            .wait
            .call0(&JsValue::UNDEFINED)
            .map_err(host_error)?
            .as_f64()
            .ok_or_else(|| io::Error::other("interactive input wait returned no size"))?;
        Ok(available as usize)
    }

    fn write(&self, bytes: &[u8]) -> io::Result<usize> {
        let written = self
            .write
            .call1(&JsValue::UNDEFINED, &js_sys::Uint8Array::from(bytes))
            .map_err(host_error)?
            .as_f64()
            .ok_or_else(|| io::Error::other("interactive output write returned no size"))?;
        if written < 0.0 {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        Ok(written as usize)
    }
}

fn host_error(error: JsValue) -> io::Error {
    io::Error::other(format!("interactive stream failed: {error:?}"))
}

pub fn run_side(
    request: InteractiveSideRequest,
    streams: HostStreams,
    on_execution: impl FnMut(bool) -> Result<(), RunError>,
) -> Result<InteractiveSideResult, RunError> {
    let program = request.program;
    if program.wasm.is_empty() {
        return Err(RunError::InvalidRequest(
            "interactive Wasm must not be empty".to_string(),
        ));
    }
    let run = RunRequest {
        wasm: program.wasm,
        args: program.args,
        env: program.env,
        stdin: Vec::new(),
        files: program.files,
        output_paths: Vec::new(),
        cwd: program.cwd,
        startup_entropy_bytes: program.startup_entropy_bytes,
        determinism: request.determinism,
        resources: program.resources,
    };
    super::validate(&run)?;
    let streams = Arc::new(streams);
    let input = StreamInput {
        streams: streams.clone(),
    };
    let Execution { result, exit_code } = execute(
        run,
        Box::new(input),
        Some(Box::new(move |capture| {
            Box::new(StreamOutput { streams, capture })
        })),
        on_execution,
    )?;
    let code = match exit_code {
        Some(code) if result.termination == ExecutionTermination::Exited => code,
        _ => result.code,
    };
    Ok(InteractiveSideResult {
        process: InteractiveProcessResult {
            code,
            stderr: result.stderr,
            termination: result.termination,
            metrics: InteractiveMetrics {
                cost: result.metrics.cost,
                operations: result.metrics.operations,
                logical_time_ns: result.metrics.logical_time_ns,
                filesystem_bytes: result.metrics.filesystem_bytes,
                filesystem_entries: result.metrics.filesystem_entries,
                protocol_bytes: result.metrics.stdout_bytes,
                stderr_bytes: result.metrics.stderr_bytes,
            },
        },
        protocol: result.stdout,
    })
}

struct StreamInput {
    streams: Arc<HostStreams>,
}

impl std::fmt::Debug for StreamInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("StreamInput")
    }
}

impl AsyncRead for StreamInput {
    fn poll_read(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(self.streams.read(buffer.remaining()).map(|chunk| {
            buffer.put_slice(&chunk);
        }))
    }
}

impl AsyncWrite for StreamInput {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for StreamInput {
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for StreamInput {
    fn last_accessed(&self) -> u64 {
        0
    }
    fn last_modified(&self) -> u64 {
        0
    }
    fn created_time(&self) -> u64 {
        0
    }
    fn size(&self) -> u64 {
        0
    }
    fn set_len(&mut self, _new_size: u64) -> Result<(), FsError> {
        Ok(())
    }
    fn unlink(&mut self) -> Result<(), FsError> {
        Ok(())
    }
    fn get_special_fd(&self) -> Option<u32> {
        Some(0)
    }

    fn poll_read_ready(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(self.streams.wait())
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
    }
}

struct StreamOutput {
    streams: Arc<HostStreams>,
    capture: CappedOutput,
}

impl std::fmt::Debug for StreamOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("StreamOutput")
    }
}

impl AsyncWrite for StreamOutput {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.capture).poll_write(context, buffer) {
            Poll::Ready(Ok(written)) => Poll::Ready(self.streams.write(&buffer[..written])),
            result => result,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for StreamOutput {
    fn poll_read(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for StreamOutput {
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for StreamOutput {
    fn last_accessed(&self) -> u64 {
        0
    }
    fn last_modified(&self) -> u64 {
        0
    }
    fn created_time(&self) -> u64 {
        0
    }
    fn size(&self) -> u64 {
        0
    }
    fn set_len(&mut self, _new_size: u64) -> Result<(), FsError> {
        Ok(())
    }
    fn unlink(&mut self) -> Result<(), FsError> {
        Ok(())
    }
    fn get_special_fd(&self) -> Option<u32> {
        Some(1)
    }

    fn poll_read_ready(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }

    fn poll_write_ready(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.capture).poll_write_ready(context)
    }
}
