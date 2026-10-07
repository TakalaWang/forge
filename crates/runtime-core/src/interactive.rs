use crate::capabilities::attach_capability_denials;
use crate::deterministic::{VirtualClock, attach_interactive_deterministic_imports};
use crate::filesystem::{
    RuntimeProjectFilesystem, is_normalized_guest_path, runtime_project_files,
};
use crate::meter::{CostPoints, MeterState, instrument_wasm, meter_state, remaining_points};
use crate::module_imports::attach_declared_memory_imports;
use crate::module_policy::{
    DEFERRED_START_EXPORT, defer_start_section, enforce_memory_limit,
    rewrite_interactive_deterministic_imports,
};
use crate::output::{CappedOutput, OutputBudget, OutputCapture};
use crate::{
    ExecutionTermination, InteractiveMetrics, InteractiveProcessResult, InteractiveProgram,
    InteractiveRequest, InteractiveResult, RunError,
};
use futures::channel::oneshot;
use std::collections::{BTreeMap, HashMap};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use virtual_fs::{FsError, Pipe, PipeRx, PipeTx, VirtualFile};
use wasmer::{AsStoreMut, Engine, Imports, Memory};
use wasmer_types::StoreId;
use wasmer_wasix::bin_factory::{run_exec, spawn_load_module};
use wasmer_wasix::os::task::TaskJoinHandle;
use wasmer_wasix::runtime::module_cache::{self, HashedModuleData, ModuleCache};
use wasmer_wasix::runtime::task_manager::TaskWasm;
use wasmer_wasix::{
    PluggableRuntime, Runtime, WasiEnv, WasiFunctionEnv, WasiRuntimeError, WasiVersion,
    generate_import_object_from_env,
};

#[derive(Debug)]
struct InteractiveInput {
    pipe: PipeRx,
}

impl AsyncRead for InteractiveInput {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipe).poll_read(context, buffer)
    }
}

impl AsyncWrite for InteractiveInput {
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

impl AsyncSeek for InteractiveInput {
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for InteractiveInput {
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
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.pipe).poll_read_ready(context)
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
    }
}

#[derive(Debug)]
struct InteractiveOutput {
    pipe: PipeTx,
    capture: CappedOutput,
}

impl AsyncWrite for InteractiveOutput {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.capture).poll_write(context, buffer) {
            Poll::Ready(Ok(written)) => {
                Pin::new(&mut self.pipe).poll_write(context, &buffer[..written])
            }
            result => result,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipe).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipe).poll_shutdown(context)
    }
}

impl AsyncRead for InteractiveOutput {
    fn poll_read(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for InteractiveOutput {
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }
    fn poll_complete(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for InteractiveOutput {
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

struct PreparedProgram {
    wasm: Vec<u8>,
    operations: BTreeMap<String, u64>,
    budget: u64,
    meter: Arc<Mutex<Option<MeterState>>>,
    protocol: OutputCapture,
    stderr: OutputCapture,
    filesystem: RuntimeProjectFilesystem,
    clock: VirtualClock,
}

pub async fn interact(request: InteractiveRequest) -> Result<InteractiveResult, RunError> {
    validate_request(&request)?;
    let contestant = prepare_program(&request.contestant, &request.determinism)?;
    let interactor = prepare_program(&request.interactor, &request.determinism)?;
    let maximum_memory = request
        .contestant
        .resources
        .memory_limit_bytes
        .max(request.interactor.resources.memory_limit_bytes);
    let engine = interactive_engine(maximum_memory)?;
    let module_cache: Arc<dyn ModuleCache + Send + Sync> = Arc::new(module_cache::in_memory());
    let contestant_wasi = Arc::new(Mutex::new(None));
    let contestant_runtime = interactive_runtime(
        engine.clone(),
        &request.determinism,
        contestant.meter.clone(),
        contestant.clock.clone(),
        request.contestant.startup_entropy_bytes,
        module_cache.clone(),
        contestant_wasi.clone(),
    )?;
    let interactor_wasi = Arc::new(Mutex::new(None));
    let interactor_runtime = interactive_runtime(
        engine,
        &request.determinism,
        interactor.meter.clone(),
        interactor.clock.clone(),
        request.interactor.startup_entropy_bytes,
        module_cache,
        interactor_wasi.clone(),
    )?;
    let (contestant_end, interactor_end) = Pipe::channel();
    let (contestant_output, contestant_input) = contestant_end.split();
    let (interactor_output, interactor_input) = interactor_end.split();
    let contestant_env = build_environment(
        "contestant",
        &request.contestant,
        contestant_input,
        contestant_output,
        &contestant,
        contestant_runtime.clone(),
    )?;
    *contestant_wasi
        .lock()
        .map_err(|error| RunError::Runtime(error.to_string()))? = Some(contestant_env.clone());
    let interactor_env = build_environment(
        "interactor",
        &request.interactor,
        interactor_input,
        interactor_output,
        &interactor,
        interactor_runtime.clone(),
    )?;
    *interactor_wasi
        .lock()
        .map_err(|error| RunError::Runtime(error.to_string()))? = Some(interactor_env.clone());
    let (mut contestant_handle, contestant_points) = spawn_metered(
        "contestant",
        &contestant,
        contestant_env,
        &contestant_runtime,
    )
    .await?;
    let (mut interactor_handle, interactor_points) = spawn_metered(
        "interactor",
        &interactor,
        interactor_env,
        &interactor_runtime,
    )
    .await?;
    let (contestant_status, interactor_status, contestant_points, interactor_points) = futures::join!(
        contestant_handle.wait_finished(),
        interactor_handle.wait_finished(),
        contestant_points,
        interactor_points,
    );

    let contestant_to_interactor = contestant.protocol.bytes();
    let interactor_to_contestant = interactor.protocol.bytes();
    let contestant_result = process_result(
        contestant_status,
        contestant_points,
        contestant,
        contestant_to_interactor.len(),
    )?;
    let interactor_result = process_result(
        interactor_status,
        interactor_points,
        interactor,
        interactor_to_contestant.len(),
    )?;
    Ok(InteractiveResult {
        contestant: contestant_result,
        interactor: interactor_result,
        contestant_to_interactor,
        interactor_to_contestant,
        determinism: request.determinism,
    })
}

/// `spawn_exec_wasm` without its CLOEXEC sweep, which a fresh environment does not need, plus a
/// recycle hook that reads the meter from the store after the process exits. WASIX reports the
/// exit before it recycles the store, so callers await both.
async fn spawn_metered(
    name: &str,
    program: &PreparedProgram,
    env: WasiEnv,
    runtime: &Arc<dyn Runtime + Send + Sync>,
) -> Result<
    (
        TaskJoinHandle,
        oneshot::Receiver<Result<CostPoints, String>>,
    ),
    RunError,
> {
    let module = spawn_load_module(name, HashedModuleData::new(program.wasm.clone()), runtime)
        .await
        .map_err(|error| RunError::Compile(format!("failed to start {name}: {error}")))?;
    let finished = env.thread.join_handle();
    let meter = program.meter.clone();
    let (points, received) = oneshot::channel();
    let task = TaskWasm::new(Box::new(run_exec), env, module, true, true).with_recycle(Box::new(
        move |mut exited| {
            let read = meter
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|meter| {
                    meter
                        .clone()
                        .ok_or_else(|| "meter is unavailable".to_string())
                })
                .and_then(|meter| remaining_points(&mut exited.store, &meter));
            let _ = points.send(read);
        },
    ));
    runtime
        .task_manager()
        .task_wasm(task)
        .map_err(|error| RunError::Compile(format!("failed to start {name}: {error}")))?;
    Ok((finished, received))
}

fn prepare_program(
    program: &InteractiveProgram,
    determinism: &crate::DeterminismConfig,
) -> Result<PreparedProgram, RunError> {
    let limited = enforce_memory_limit(&program.wasm, program.resources.memory_limit_bytes)
        .map_err(RunError::Compile)?;
    let metered = instrument_wasm(&limited, program.resources.instruction_budget)
        .map_err(RunError::Compile)?;
    let executable = defer_start_section(&metered.wasm).map_err(RunError::Compile)?;
    let wasm =
        rewrite_interactive_deterministic_imports(&executable.wasm).map_err(RunError::Compile)?;
    let limit = usize::try_from(program.resources.output_limit_bytes)
        .map_err(|_| RunError::InvalidRequest("output limit exceeds host range".to_string()))?;
    let output_budget = OutputBudget::new(limit);
    let (protocol, _) = OutputCapture::new(output_budget.clone(), 1);
    let (stderr, _) = OutputCapture::new(output_budget, 2);
    let filesystem = runtime_project_files(&program.files, &[], determinism, &program.resources)?;
    Ok(PreparedProgram {
        wasm,
        operations: metered.operations,
        budget: program.resources.instruction_budget,
        meter: Arc::new(Mutex::new(None)),
        protocol,
        stderr,
        filesystem,
        clock: VirtualClock::new(determinism, program.resources.logical_time_limit_ms),
    })
}

#[allow(clippy::too_many_arguments)]
fn build_environment(
    name: &str,
    program: &InteractiveProgram,
    input: PipeRx,
    output: PipeTx,
    prepared: &PreparedProgram,
    runtime: Arc<dyn Runtime + Send + Sync>,
) -> Result<WasiEnv, RunError> {
    let protocol_file = prepared.protocol.file(1);
    let stderr_file = prepared.stderr.file(2);
    let filesystem = prepared.filesystem.filesystem();
    let mut builder = WasiEnv::builder(name)
        .runtime(runtime)
        .args(program.args.clone())
        .envs(program.env.clone())
        .stdin(Box::new(InteractiveInput { pipe: input }))
        .stdout(Box::new(InteractiveOutput {
            pipe: output,
            capture: protocol_file,
        }))
        .stderr(Box::new(stderr_file))
        .fs(filesystem);
    builder
        .add_preopen_build(|directory| directory.directory("/").read(true).write(true).create(true))
        .map_err(|error| {
            RunError::InvalidRequest(format!("failed to preopen interactive filesystem: {error}"))
        })?;
    if let Some(cwd) = &program.cwd {
        builder.set_current_dir(cwd);
    }
    builder.build().map_err(|error| {
        RunError::Compile(format!("failed to build {name} WASI environment: {error}"))
    })
}

fn process_result(
    status: Result<wasmer_wasix::wasmer_wasix_types::wasi::ExitCode, Arc<WasiRuntimeError>>,
    points: Result<Result<CostPoints, String>, oneshot::Canceled>,
    prepared: PreparedProgram,
    protocol_bytes: usize,
) -> Result<InteractiveProcessResult, RunError> {
    let stderr = prepared.stderr.bytes();
    let output_exceeded = prepared.protocol.exceeded() || prepared.stderr.exceeded();
    let points = points
        .map_err(|_| RunError::Runtime("interactive process exited without its meter".to_string()))?
        .map_err(RunError::Runtime)?;
    let exhausted = points == CostPoints::Exhausted;
    let cost = match points {
        CostPoints::Remaining(points) => prepared.budget.saturating_sub(points),
        CostPoints::Exhausted => prepared.budget,
    };
    let logical_time_exceeded = prepared.clock.limit_exceeded()?;
    let (code, termination) = if prepared.filesystem.quota_exceeded() {
        (137, ExecutionTermination::FilesystemLimit)
    } else if output_exceeded {
        (137, ExecutionTermination::OutputLimit)
    } else if logical_time_exceeded {
        (137, ExecutionTermination::LogicalTimeLimit)
    } else if exhausted {
        (137, ExecutionTermination::InstructionLimit)
    } else {
        match status {
            Ok(code) => (code.raw(), ExecutionTermination::Exited),
            Err(error) => match error.as_exit_code() {
                Some(code) => (code.raw(), ExecutionTermination::Exited),
                None => (1, ExecutionTermination::Trap),
            },
        }
    };
    let filesystem_metrics = prepared.filesystem.metrics();
    Ok(InteractiveProcessResult {
        code,
        stderr,
        termination,
        metrics: InteractiveMetrics {
            cost,
            operations: prepared.operations,
            logical_time_ns: prepared.clock.elapsed_ns()?,
            filesystem_bytes: filesystem_metrics.bytes,
            filesystem_entries: filesystem_metrics.entries,
            protocol_bytes: protocol_bytes as u64,
            stderr_bytes: prepared.stderr.bytes().len() as u64,
        },
    })
}

fn validate_request(request: &InteractiveRequest) -> Result<(), RunError> {
    crate::run::validate_determinism(&request.determinism)?;
    for (label, program) in [
        ("contestant", &request.contestant),
        ("interactor", &request.interactor),
    ] {
        if program.wasm.is_empty() {
            return Err(RunError::InvalidRequest(format!(
                "{label} Wasm must not be empty"
            )));
        }
        crate::run::validate_resource_policy(&program.resources, label)?;
        crate::run::validate_mounted_files(&program.files, label)?;
        if program.startup_entropy_bytes > 4_096 {
            return Err(RunError::InvalidRequest(format!(
                "{label} startupEntropyBytes must be at most 4096"
            )));
        }
        if let Some(cwd) = &program.cwd
            && !is_normalized_guest_path(cwd)
        {
            return Err(RunError::InvalidRequest(format!(
                "{label} cwd must be an absolute normalized guest path"
            )));
        }
    }
    Ok(())
}

fn interactive_runtime(
    engine: Engine,
    determinism: &crate::DeterminismConfig,
    meter: Arc<Mutex<Option<MeterState>>>,
    clock: VirtualClock,
    startup_entropy_bytes: u64,
    module_cache: Arc<dyn ModuleCache + Send + Sync>,
    environment: Arc<Mutex<Option<WasiEnv>>>,
) -> Result<Arc<dyn Runtime + Send + Sync>, RunError> {
    struct PendingInstance {
        memory: Arc<Mutex<Option<Memory>>>,
        wasi: WasiFunctionEnv,
    }
    let pending: Arc<Mutex<HashMap<StoreId, PendingInstance>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let imports_pending = pending.clone();
    let instance_pending = pending;
    let config = determinism.clone();
    let mut runtime = interactive_runtime_base(engine);
    runtime.module_cache = module_cache;
    runtime.with_additional_imports(move |module, store| {
        let store_id = store.objects_mut().id();
        let memory = Arc::new(Mutex::new(None));
        let wasi_environment = environment
            .lock()
            .map_err(|error| io::Error::other(error.to_string()))?
            .clone()
            .ok_or_else(|| io::Error::other("interactive WASI environment is unavailable"))?;
        let wasi = WasiFunctionEnv::new(&mut *store, wasi_environment);
        if imports_pending
            .lock()
            .map_err(|error| io::Error::other(error.to_string()))?
            .insert(
                store_id,
                PendingInstance {
                    memory: memory.clone(),
                    wasi: wasi.clone(),
                },
            )
            .is_some()
        {
            return Err(
                io::Error::other("interactive runtime received duplicate store state").into(),
            );
        }
        let mut imports = Imports::new();
        for version in [
            WasiVersion::Snapshot1,
            WasiVersion::Wasix32v1,
            WasiVersion::Wasix64v1,
        ] {
            imports.extend(&generate_import_object_from_env(
                &mut *store,
                &wasi.env,
                version,
            ));
        }
        attach_interactive_deterministic_imports(
            store,
            &mut imports,
            memory,
            &config,
            clock.clone(),
            startup_entropy_bytes,
        );
        attach_capability_denials(store, module, &mut imports).map_err(io::Error::other)?;
        attach_declared_memory_imports(store, module, &mut imports).map_err(io::Error::other)?;
        Ok(imports)
    });
    runtime.with_instance_setup(move |_module, store, instance, imported_memory| {
        let store_id = store.objects_mut().id();
        let mut pending = instance_pending
            .lock()
            .map_err(|error| io::Error::other(error.to_string()))?
            .remove(&store_id)
            .ok_or_else(|| io::Error::other("interactive instance has no host state"))?;
        let memory = instance
            .exports
            .get_memory("memory")
            .cloned()
            .ok()
            .or_else(|| imported_memory.cloned())
            .ok_or_else(|| io::Error::other("interactive instance has no linear memory"))?;
        *pending
            .memory
            .lock()
            .map_err(|error| io::Error::other(error.to_string()))? = Some(memory);
        *meter
            .lock()
            .map_err(|error| io::Error::other(error.to_string()))? =
            Some(meter_state(instance).map_err(io::Error::other)?);
        pending
            .wasi
            .initialize(&mut *store, instance.clone())
            .map_err(io::Error::other)?;
        if let Ok(initializer) = instance.exports.get_function(DEFERRED_START_EXPORT) {
            initializer
                .call(&mut *store, &[])
                .map_err(io::Error::other)?;
        }
        Ok(())
    });
    Ok(Arc::new(runtime))
}

#[cfg(target_arch = "wasm32")]
fn interactive_runtime_base(engine: Engine) -> PluggableRuntime {
    let tasks: Arc<dyn wasmer_wasix::runtime::task_manager::VirtualTaskManager> =
        Arc::new(crate::run::web_runtime::WebTaskManager);
    let mut runtime = PluggableRuntime::new(tasks);
    runtime.set_engine(engine);
    runtime
}

#[cfg(not(target_arch = "wasm32"))]
fn interactive_runtime_base(engine: Engine) -> PluggableRuntime {
    use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;
    let tasks: Arc<dyn wasmer_wasix::runtime::task_manager::VirtualTaskManager> =
        Arc::new(TokioTaskManager::default());
    let mut runtime = PluggableRuntime::new(tasks);
    runtime.set_engine(engine);
    runtime
}

#[cfg(target_arch = "wasm32")]
fn interactive_engine(_memory_limit_bytes: u64) -> Result<Engine, RunError> {
    Ok(Engine::default())
}

#[cfg(not(target_arch = "wasm32"))]
fn interactive_engine(memory_limit_bytes: u64) -> Result<Engine, RunError> {
    use crate::memory::LimitingTunables;
    use wasmer::Pages;
    use wasmer::sys::{BaseTunables, Cranelift, NativeEngineExt, Target};
    let pages = u32::try_from(memory_limit_bytes / 65_536).map_err(|_| {
        RunError::InvalidRequest("memory limit exceeds Wasmer page range".to_string())
    })?;
    let base = BaseTunables::for_target(&Target::default());
    let mut engine: Engine = Cranelift::default().into();
    engine.set_tunables(LimitingTunables::new(base, Pages(pages)));
    Ok(engine)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::interact;
    use crate::{
        DeterminismConfig, ExecutionTermination, InteractiveProgram, InteractiveRequest,
        ResourcePolicy, RunRequest,
    };
    use std::collections::BTreeMap;

    #[test]
    fn connects_contestant_and_interactor_with_independent_metering() {
        let contestant = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "fd_read"
                (func $fd_read (param i32 i32 i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
              (memory (export "memory") 1)
              (data (i32.const 80) "42\n")
              (func (export "_start")
                (i32.store (i32.const 0) (i32.const 64))
                (i32.store (i32.const 4) (i32.const 3))
                (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
                (i32.store (i32.const 16) (i32.const 80))
                (i32.store (i32.const 20) (i32.const 3))
                (drop (call $fd_write (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 24)))))"#,
        )
        .unwrap();
        let interactor = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "fd_read"
                (func $fd_read (param i32 i32 i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
              (memory (export "memory") 1)
              (data (i32.const 80) "41\n")
              (func (export "_start")
                (i32.store (i32.const 16) (i32.const 80))
                (i32.store (i32.const 20) (i32.const 3))
                (drop (call $fd_write (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 24)))
                (i32.store (i32.const 0) (i32.const 64))
                (i32.store (i32.const 4) (i32.const 3))
                (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))))"#,
        )
        .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(interact(InteractiveRequest {
                contestant: program(contestant),
                interactor: program(interactor),
                determinism: DeterminismConfig {
                    random_seed: 7,
                    realtime_epoch_ms: 946_684_800_000,
                    clock_step_ns: 1_000_000,
                },
            }))
            .unwrap();
        assert_eq!(result.contestant_to_interactor, b"42\n");
        assert_eq!(result.interactor_to_contestant, b"41\n");
        assert_eq!(result.contestant.termination, ExecutionTermination::Exited);
        assert_eq!(result.interactor.termination, ExecutionTermination::Exited);
        assert_eq!(result.contestant.code, 0);
        assert_eq!(result.interactor.code, 0);
        assert!(result.contestant.metrics.cost > 0);
        assert!(result.interactor.metrics.cost > 0);
    }

    #[test]
    fn applies_filesystem_quota_independently_to_each_interactive_program() {
        let writer = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "path_open"
                (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "fd_write"
                (func $write (param i32 i32 i32 i32) (result i32)))
              (memory (export "memory") 1)
              (data (i32.const 0) "created.txt")
              (data (i32.const 80) "\60\00\00\00\08\00\00\00")
              (data (i32.const 96) "12345678")
              (func (export "_start")
                i32.const 4 i32.const 0 i32.const 0 i32.const 11 i32.const 1
                i64.const 64 i64.const 0 i32.const 0 i32.const 64 call $open drop
                i32.const 64 i32.load i32.const 80 i32.const 1 i32.const 88 call $write drop))"#,
        )
        .unwrap();
        let idle =
            wat::parse_str(r#"(module (memory (export "memory") 1) (func (export "_start")))"#)
                .unwrap();
        let mut contestant = program(writer);
        contestant.resources.filesystem_write_limit_bytes = 4;
        contestant.resources.filesystem_entry_limit = 1;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(interact(InteractiveRequest {
                contestant,
                interactor: program(idle),
                determinism: DeterminismConfig {
                    random_seed: 7,
                    realtime_epoch_ms: 946_684_800_000,
                    clock_step_ns: 1_000_000,
                },
            }))
            .unwrap();

        assert_eq!(
            result.contestant.termination,
            ExecutionTermination::FilesystemLimit
        );
        assert_eq!(result.contestant.code, 137);
        assert_eq!(result.contestant.metrics.filesystem_bytes, 0);
        assert_eq!(result.contestant.metrics.filesystem_entries, 1);
        assert_eq!(result.interactor.termination, ExecutionTermination::Exited);
        assert_eq!(result.interactor.metrics.filesystem_bytes, 0);
        assert_eq!(result.interactor.metrics.filesystem_entries, 0);
    }

    #[test]
    fn applies_logical_time_budgets_independently_to_each_interactive_program() {
        let sleeper = wat::parse_str(
            r#"(module
              (import "wasix_32v1" "thread_sleep" (func $sleep (param i64) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start") i64.const 11000000 call $sleep drop))"#,
        )
        .unwrap();
        let idle =
            wat::parse_str(r#"(module (memory (export "memory") 1) (func (export "_start")))"#)
                .unwrap();
        let mut contestant = program(sleeper);
        contestant.resources.logical_time_limit_ms = 10;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(interact(InteractiveRequest {
                contestant,
                interactor: program(idle),
                determinism: DeterminismConfig {
                    random_seed: 7,
                    realtime_epoch_ms: 946_684_800_000,
                    clock_step_ns: 1_000_000,
                },
            }))
            .unwrap();

        assert_eq!(
            result.contestant.termination,
            ExecutionTermination::LogicalTimeLimit
        );
        assert_eq!(result.contestant.metrics.logical_time_ns, 10_000_000);
        assert_eq!(result.interactor.termination, ExecutionTermination::Exited);
        assert_eq!(result.interactor.metrics.logical_time_ns, 0);
    }

    #[test]
    fn interactive_wasi_poll_fast_forwards_the_process_clock() {
        let sleeper = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "poll_oneoff"
                (func $poll (param i32 i32 i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "clock_time_get"
                (func $clock (param i32 i64 i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                i32.const 0 i64.const 7 i64.store
                i32.const 8 i32.const 0 i32.store8
                i32.const 16 i32.const 1 i32.store
                i32.const 24 i64.const 5000000000 i64.store
                i32.const 32 i64.const 1 i64.store
                i32.const 40 i32.const 0 i32.store16
                i32.const 0 i32.const 64 i32.const 1 i32.const 120 call $poll drop
                i32.const 1 i64.const 0 i32.const 128 call $clock drop))"#,
        )
        .unwrap();
        let idle =
            wat::parse_str(r#"(module (memory (export "memory") 1) (func (export "_start")))"#)
                .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(interact(InteractiveRequest {
                contestant: program(sleeper),
                interactor: program(idle),
                determinism: DeterminismConfig {
                    random_seed: 7,
                    realtime_epoch_ms: 946_684_800_000,
                    clock_step_ns: 1_000_000,
                },
            }))
            .unwrap();

        assert_eq!(result.contestant.termination, ExecutionTermination::Exited);
        assert_eq!(result.contestant.metrics.logical_time_ns, 5_001_000_000);
        assert_eq!(result.interactor.metrics.logical_time_ns, 0);
    }

    #[test]
    fn interactive_native_start_observes_the_initialized_process_clock() {
        let initialized = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "clock_time_get"
                (func $clock (param i32 i64 i32) (result i32)))
              (memory (export "memory") 1)
              (func $initialize
                i32.const 1 i64.const 0 i32.const 0 call $clock drop)
              (start $initialize)
              (func (export "_start")))"#,
        )
        .unwrap();
        let idle =
            wat::parse_str(r#"(module (memory (export "memory") 1) (func (export "_start")))"#)
                .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(interact(InteractiveRequest {
                contestant: program(initialized),
                interactor: program(idle),
                determinism: DeterminismConfig {
                    random_seed: 7,
                    realtime_epoch_ms: 946_684_800_000,
                    clock_step_ns: 1_000_000,
                },
            }))
            .unwrap();

        assert_eq!(result.contestant.termination, ExecutionTermination::Exited);
        assert_eq!(result.contestant.metrics.logical_time_ns, 1_000_000);
        assert_eq!(result.interactor.metrics.logical_time_ns, 0);
    }

    #[test]
    fn interactive_absolute_realtime_poll_uses_the_process_clock() {
        let sleeper = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "poll_oneoff"
                (func $poll (param i32 i32 i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "clock_time_get"
                (func $clock (param i32 i64 i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                i32.const 0 i64.const 7 i64.store
                i32.const 8 i32.const 0 i32.store8
                i32.const 16 i32.const 0 i32.store
                i32.const 24 i64.const 946684805000000000 i64.store
                i32.const 32 i64.const 1 i64.store
                i32.const 40 i32.const 1 i32.store16
                i32.const 0 i32.const 64 i32.const 1 i32.const 120 call $poll drop
                i32.const 0 i64.const 0 i32.const 128 call $clock drop))"#,
        )
        .unwrap();
        let idle =
            wat::parse_str(r#"(module (memory (export "memory") 1) (func (export "_start")))"#)
                .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(interact(InteractiveRequest {
                contestant: program(sleeper),
                interactor: program(idle),
                determinism: DeterminismConfig {
                    random_seed: 7,
                    realtime_epoch_ms: 946_684_800_000,
                    clock_step_ns: 1_000_000,
                },
            }))
            .unwrap();

        assert_eq!(result.contestant.termination, ExecutionTermination::Exited);
        assert_eq!(result.contestant.metrics.logical_time_ns, 5_001_000_000);
        assert_eq!(result.interactor.metrics.logical_time_ns, 0);
    }

    #[test]
    fn interactive_ready_fd_wins_without_advancing_the_process_clock() {
        let waiter = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "poll_oneoff"
                (func $poll (param i32 i32 i32 i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                i32.const 0 i64.const 1 i64.store
                i32.const 8 i32.const 2 i32.store8
                i32.const 16 i32.const 1 i32.store
                i32.const 48 i64.const 2 i64.store
                i32.const 56 i32.const 0 i32.store8
                i32.const 64 i32.const 1 i32.store
                i32.const 72 i64.const 5000000000 i64.store
                i32.const 80 i64.const 1 i64.store
                i32.const 88 i32.const 0 i32.store16
                i32.const 0 i32.const 128 i32.const 2 i32.const 240 call $poll drop))"#,
        )
        .unwrap();
        let idle =
            wat::parse_str(r#"(module (memory (export "memory") 1) (func (export "_start")))"#)
                .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(interact(InteractiveRequest {
                contestant: program(waiter),
                interactor: program(idle),
                determinism: DeterminismConfig {
                    random_seed: 7,
                    realtime_epoch_ms: 946_684_800_000,
                    clock_step_ns: 1_000_000,
                },
            }))
            .unwrap();

        assert_eq!(result.contestant.termination, ExecutionTermination::Exited);
        assert_eq!(result.contestant.metrics.logical_time_ns, 0);
        assert_eq!(result.interactor.metrics.logical_time_ns, 0);
    }

    #[test]
    fn interactive_empty_stdin_poll_times_out_on_the_process_clock() {
        let poller = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "poll_oneoff"
                (func $poll (param i32 i32 i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                i32.const 0 i64.const 1 i64.store
                i32.const 8 i32.const 1 i32.store8
                i32.const 16 i32.const 0 i32.store
                i32.const 48 i64.const 2 i64.store
                i32.const 56 i32.const 0 i32.store8
                i32.const 64 i32.const 1 i32.store
                i32.const 72 i64.const 5000000000 i64.store
                i32.const 80 i64.const 1 i64.store
                i32.const 88 i32.const 0 i32.store16
                i32.const 0 i32.const 128 i32.const 2 i32.const 240 call $poll drop
                i32.const 200 i32.const 138 i32.store
                i32.const 204 i32.const 1 i32.store
                i32.const 208 i32.const 240 i32.store
                i32.const 212 i32.const 1 i32.store
                i32.const 1 i32.const 200 i32.const 2 i32.const 216 call $fd_write drop))"#,
        )
        .unwrap();
        let listener = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "fd_read"
                (func $fd_read (param i32 i32 i32 i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                (i32.store (i32.const 0) (i32.const 64))
                (i32.store (i32.const 4) (i32.const 8))
                (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))))"#,
        )
        .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(interact(InteractiveRequest {
                contestant: program(poller),
                interactor: program(listener),
                determinism: DeterminismConfig {
                    random_seed: 7,
                    realtime_epoch_ms: 946_684_800_000,
                    clock_step_ns: 1_000_000,
                },
            }))
            .unwrap();

        assert_eq!(result.contestant_to_interactor, [0, 1]);
        assert_eq!(result.contestant.termination, ExecutionTermination::Exited);
        assert_eq!(result.contestant.metrics.logical_time_ns, 5_000_000_000);
        assert_eq!(result.interactor.termination, ExecutionTermination::Exited);
    }

    #[test]
    fn interactive_contestant_is_metered_like_a_standalone_run() {
        let looping = |ending: &str| {
            wat::parse_str(format!(
                r#"(module
                  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
                  (memory (export "memory") 1)
                  (func (export "_start")
                    (local $remaining i32)
                    i32.const 1000 local.set $remaining
                    (loop $again
                      local.get $remaining i32.const 1 i32.sub local.tee $remaining
                      br_if $again)
                    {ending}))"#
            ))
            .unwrap()
        };
        let determinism = DeterminismConfig {
            random_seed: 7,
            realtime_epoch_ms: 946_684_800_000,
            clock_step_ns: 1_000_000,
        };
        let execute = |wasm: &[u8], instruction_budget: u64| {
            let mut contestant = program(wasm.to_vec());
            contestant.resources.instruction_budget = instruction_budget;
            let standalone = crate::run(RunRequest {
                wasm: contestant.wasm.clone(),
                args: Vec::new(),
                env: BTreeMap::new(),
                stdin: Vec::new(),
                files: BTreeMap::new(),
                output_paths: Vec::new(),
                cwd: contestant.cwd.clone(),
                startup_entropy_bytes: 0,
                determinism: determinism.clone(),
                resources: contestant.resources.clone(),
            })
            .unwrap();
            let interactive = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(interact(InteractiveRequest {
                    interactor: contestant.clone(),
                    contestant,
                    determinism: determinism.clone(),
                }))
                .unwrap();
            assert_eq!(interactive.interactor.code, interactive.contestant.code);
            assert_eq!(
                interactive.interactor.termination,
                interactive.contestant.termination
            );
            assert_eq!(
                interactive.interactor.metrics.cost,
                interactive.contestant.metrics.cost
            );
            (standalone, interactive.contestant)
        };

        for (ending, code) in [("", 0), ("i32.const 3 call $exit", 3)] {
            let wasm = looping(ending);
            let (standalone, interactive) = execute(&wasm, 1_000_000);
            assert_eq!(standalone.termination, ExecutionTermination::Exited);
            assert_eq!(standalone.code, code);
            assert_eq!(interactive.termination, ExecutionTermination::Exited);
            assert_eq!(interactive.code, code);
            assert_eq!(interactive.metrics.cost, standalone.metrics.cost);

            let budget = standalone.metrics.cost - 1;
            let (standalone, interactive) = execute(&wasm, budget);
            assert_eq!(
                standalone.termination,
                ExecutionTermination::InstructionLimit
            );
            assert_eq!(
                interactive.termination,
                ExecutionTermination::InstructionLimit
            );
            assert_eq!(interactive.code, 137);
            assert_eq!(interactive.metrics.cost, budget);
            assert_eq!(interactive.metrics.cost, standalone.metrics.cost);
        }

        let (standalone, interactive) = execute(&looping("unreachable"), 1_000_000);
        assert_eq!(standalone.termination, ExecutionTermination::Trap);
        assert_eq!(interactive.metrics.cost, standalone.metrics.cost);
    }

    fn program(wasm: Vec<u8>) -> InteractiveProgram {
        InteractiveProgram {
            wasm,
            args: Vec::new(),
            env: BTreeMap::new(),
            files: BTreeMap::new(),
            cwd: Some("/".to_string()),
            startup_entropy_bytes: 0,
            resources: ResourcePolicy {
                instruction_budget: 1_000_000,
                logical_time_limit_ms: 60_000,
                memory_limit_bytes: 64 * 1024 * 1024,
                output_limit_bytes: 1024,
                filesystem_write_limit_bytes: 64 * 1024 * 1024,
                filesystem_entry_limit: 4_096,
            },
        }
    }
}
