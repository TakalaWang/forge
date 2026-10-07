use super::web_runtime::runtime_with_engine;
use crate::capabilities::attach_capability_denials;
use crate::deterministic::{VirtualClock, attach_deterministic_imports};
use crate::filesystem::{read_files_bounded, runtime_project_files};
use crate::meter::{CostPoints, METER_MODEL, instrument_wasm, meter_state, remaining_points};
use crate::module_imports::attach_imported_memory;
use crate::module_policy::{DEFERRED_START_EXPORT, defer_start_section, enforce_memory_limit};
use crate::output::{OutputBudget, OutputCapture};
use crate::{ExecutionMetrics, ExecutionTermination, RunError, RunRequest, RunResult};
use std::io::Write;
use std::sync::{Arc, Mutex};
use wasmer::{Instance, Memory, Module, Store};
use wasmer_wasix::{
    Pipe, WasiEnv, WasiError, WasiModuleInstanceHandles, WasiModuleTreeHandles, wasmer_wasix_types,
};

pub fn run(
    request: RunRequest,
    mut on_execution: impl FnMut(bool) -> Result<(), RunError>,
) -> Result<RunResult, RunError> {
    let limited = enforce_memory_limit(&request.wasm, request.resources.memory_limit_bytes)
        .map_err(RunError::Compile)?;
    let metered = instrument_wasm(&limited, request.resources.instruction_budget)
        .map_err(RunError::Compile)?;
    let executable = defer_start_section(&metered.wasm).map_err(RunError::Compile)?;
    let mut store = Store::default();
    let module = Module::new(&store, &executable.wasm).map_err(|error| {
        RunError::Compile(format!("failed to compile instrumented module: {error}"))
    })?;
    let runtime = runtime_with_engine(store.engine().clone());

    let (mut stdin_writer, stdin_reader) = Pipe::channel();
    stdin_writer
        .write_all(&request.stdin)
        .map_err(|error| RunError::Io(error.to_string()))?;
    drop(stdin_writer);
    let output_limit = usize::try_from(request.resources.output_limit_bytes)
        .map_err(|_| RunError::InvalidRequest("output limit exceeds host range".to_string()))?;
    let output_budget = OutputBudget::new(output_limit);
    let (stdout_capture, stdout_file) = OutputCapture::new(output_budget.clone(), 1);
    let (stderr_capture, stderr_file) = OutputCapture::new(output_budget, 2);

    let project_filesystem = runtime_project_files(
        &request.files,
        &request.output_paths,
        &request.determinism,
        &request.resources,
    )?;
    let filesystem = project_filesystem.filesystem();
    let mut builder = WasiEnv::builder("app")
        .runtime(runtime)
        .args(request.args.clone())
        .envs(request.env.clone())
        .stdin(Box::new(stdin_reader))
        .stdout(Box::new(stdout_file))
        .stderr(Box::new(stderr_file))
        .fs(filesystem.clone());
    builder
        .add_preopen_build(|directory| directory.directory("/").read(true).write(true).create(true))
        .map_err(|error| {
            RunError::InvalidRequest(format!("failed to preopen guest filesystem: {error}"))
        })?;
    if let Some(cwd) = &request.cwd {
        builder.set_current_dir(cwd);
    }
    let mut sandbox = builder.finalize(&mut store).map_err(|error| {
        RunError::Compile(format!("failed to finalize WASI environment: {error}"))
    })?;
    let mut imports = sandbox
        .import_object_for_all_wasi_versions(&mut store, &module)
        .map_err(|error| RunError::Compile(format!("failed to create WASI imports: {error}")))?;
    let memory_slot: Arc<Mutex<Option<Memory>>> = Arc::new(Mutex::new(None));
    let clock = VirtualClock::new(
        &request.determinism,
        request.resources.logical_time_limit_ms,
    );
    attach_deterministic_imports(
        &mut store,
        &mut imports,
        memory_slot.clone(),
        &request.determinism,
        clock.clone(),
        request.startup_entropy_bytes,
    );
    attach_capability_denials(&mut store, &module, &mut imports).map_err(RunError::Compile)?;
    let imported_memory =
        attach_imported_memory(&mut store, &module, &mut imports).map_err(RunError::Compile)?;
    let instance = Instance::new(&mut store, &module, &imports)
        .map_err(|error| RunError::Compile(format!("failed to instantiate module: {error}")))?;
    let meter = meter_state(&instance).map_err(RunError::Runtime)?;
    let guest_memory = instance
        .exports
        .get_memory("memory")
        .cloned()
        .ok()
        .or(imported_memory)
        .ok_or_else(|| RunError::Compile("module has no guest linear memory".to_string()))?;
    *memory_slot
        .lock()
        .map_err(|error| RunError::Runtime(error.to_string()))? = Some(guest_memory.clone());
    let handles = WasiModuleTreeHandles::Static(WasiModuleInstanceHandles::new(
        guest_memory.clone(),
        &store,
        instance.clone(),
        None,
    ));
    sandbox
        .initialize_handles_and_layout(&mut store, instance.clone(), handles, None, true)
        .map_err(|error| {
            RunError::Compile(format!("failed to initialize WASI instance: {error}"))
        })?;
    let start = instance
        .exports
        .get_function("_start")
        .map_err(|error| RunError::Compile(format!("module has no _start function: {error}")))?;
    on_execution(true)?;
    let execution = if executable.has_deferred_start {
        let initializer = instance
            .exports
            .get_function(DEFERRED_START_EXPORT)
            .map_err(|error| {
                RunError::Runtime(format!("deferred start function is unavailable: {error}"))
            })?;
        match initializer.call(&mut store, &[]) {
            Ok(_) => start.call(&mut store, &[]),
            Err(error) => Err(error),
        }
    } else {
        start.call(&mut store, &[])
    };

    on_execution(false)?;

    let stdout = stdout_capture.bytes();
    let stderr = stderr_capture.bytes();
    let mut output_exceeded = stdout_capture.exceeded() || stderr_capture.exceeded();
    let remaining = remaining_points(&mut store, &meter).map_err(RunError::Runtime)?;
    let logical_time_exceeded = clock.limit_exceeded()?;

    let mut code = 0;
    let mut termination = ExecutionTermination::Exited;
    let mut trap_message = None;
    if let Err(error) = execution {
        if let Some(wasi_error) = crate::wasi_error(&error) {
            match wasi_error {
                WasiError::Exit(exit) => {
                    let errno: wasmer_wasix_types::wasi::Errno = (*exit).into();
                    if errno != wasmer_wasix_types::wasi::Errno::Success {
                        code = errno as i32;
                    }
                }
                WasiError::UnknownWasiVersion => {
                    return Err(RunError::WasiUnsupported(
                        "unknown WASI version".to_string(),
                    ));
                }
                WasiError::ThreadExit => {
                    return Err(RunError::WasiUnsupported("thread exit".to_string()));
                }
                WasiError::DeepSleep(_) => {
                    return Err(RunError::WasiUnsupported("deep sleep".to_string()));
                }
                WasiError::DlSymbolResolutionFailed(symbol) => {
                    return Err(RunError::WasiUnsupported(format!(
                        "unresolved symbol {symbol}"
                    )));
                }
            }
        } else {
            trap_message = Some(super::canonical_trap_message(&error.to_string()));
            termination = ExecutionTermination::Trap;
            code = 1;
        }
    }

    sandbox.on_exit(
        &mut store,
        Some(wasmer_wasix_types::wasi::Errno::Success.into()),
    );
    let captured_bytes = stdout.len().saturating_add(stderr.len());
    let remaining_output = output_limit.saturating_sub(captured_bytes);
    let (files, file_output_exceeded) =
        read_files_bounded(&filesystem, &request.output_paths, remaining_output)?;
    output_exceeded |= file_output_exceeded;

    if project_filesystem.quota_exceeded() {
        code = 137;
        termination = ExecutionTermination::FilesystemLimit;
    } else if output_exceeded {
        code = 137;
        termination = ExecutionTermination::OutputLimit;
    } else if logical_time_exceeded {
        code = 137;
        termination = ExecutionTermination::LogicalTimeLimit;
    } else if matches!(remaining, CostPoints::Exhausted) {
        code = 137;
        termination = ExecutionTermination::InstructionLimit;
    }
    let memory_bytes = u64::from(guest_memory.size(&store).0) * 65_536;
    if memory_bytes > request.resources.memory_limit_bytes {
        code = 137;
        termination = ExecutionTermination::MemoryLimit;
    }
    if termination != ExecutionTermination::Trap {
        trap_message = None;
    }
    let cost = match remaining {
        CostPoints::Remaining(points) => {
            request.resources.instruction_budget.saturating_sub(points)
        }
        CostPoints::Exhausted => request.resources.instruction_budget,
    };
    let filesystem_metrics = project_filesystem.metrics();
    Ok(RunResult {
        code,
        metrics: ExecutionMetrics {
            cost,
            cost_model: METER_MODEL.to_string(),
            operations: metered.operations,
            memory_bytes,
            logical_time_ns: clock.elapsed_ns()?,
            filesystem_bytes: filesystem_metrics.bytes,
            filesystem_entries: filesystem_metrics.entries,
            stdout_bytes: stdout.len() as u64,
            stderr_bytes: stderr.len() as u64,
        },
        stdout,
        stderr,
        files,
        termination,
        trap_message,
        determinism: request.determinism,
        resources: request.resources,
    })
}
