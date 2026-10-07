use crate::{
    RunError,
    module_policy::{
        INTERACTIVE_WASIP1_DETERMINISTIC_NAMESPACE, INTERACTIVE_WASIX32_DETERMINISTIC_NAMESPACE,
        INTERACTIVE_WASIX64_DETERMINISTIC_NAMESPACE,
    },
    types::DeterminismConfig,
};
use std::cell::Cell;
use std::sync::{Arc, Mutex};
use wasmer::{
    AsStoreMut, Extern, Function, FunctionEnv, FunctionEnvMut, Imports, Memory, Memory32, Memory64,
    MemorySize, RuntimeError, Value, WasmPtr,
};
use wasmer_wasix::wasmer_wasix_types::wasi::{
    Clockid, Errno, Event, EventUnion, Eventtype, Subclockflags, Subscription, SubscriptionUnion,
};

const FSTFLAGS_ATIM: u32 = 1 << 0;
const FSTFLAGS_ATIM_NOW: u32 = 1 << 1;
const FSTFLAGS_MTIM: u32 = 1 << 2;
const FSTFLAGS_MTIM_NOW: u32 = 1 << 3;

/// Compiler processes use one contract-fixed deterministic environment.
///
/// Project execution determinism is intentionally excluded from build cache
/// identities, so no project-controlled seed or clock may reach a compiler.
pub(crate) const COMPILER_DETERMINISM: DeterminismConfig = DeterminismConfig {
    random_seed: 0x5eed_1234,
    realtime_epoch_ms: 946_684_800_000,
    clock_step_ns: 1_000_000,
};

#[derive(Debug)]
struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        let mut value = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        self.state = value;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^ (value >> 31)
    }

    fn fill(&mut self, output: &mut [u8]) {
        for chunk in output.chunks_mut(8) {
            let bytes = self.next().to_le_bytes();
            chunk.copy_from_slice(&bytes[..chunk.len()]);
        }
    }
}

#[derive(Debug)]
struct VirtualClockState {
    epoch_ns: u64,
    step_ns: u64,
    elapsed_ns: u64,
    limit_ns: u64,
    limit_exceeded: bool,
}

impl VirtualClockState {
    fn supports(clock_id: u32) -> bool {
        matches!(
            clock_id,
            value if value == Clockid::Realtime as u32
                || value == Clockid::Monotonic as u32
                || value == Clockid::ProcessCputimeId as u32
                || value == Clockid::ThreadCputimeId as u32
        )
    }

    fn value(&self, clock_id: u32) -> Result<u64, RuntimeError> {
        let origin = if clock_id == Clockid::Realtime as u32 {
            self.epoch_ns
        } else {
            0
        };
        origin
            .checked_add(self.elapsed_ns)
            .ok_or_else(|| RuntimeError::new("WASM-OJ virtual clock overflowed"))
    }

    fn advance_to(&mut self, target_ns: u64) -> Result<(), RuntimeError> {
        if target_ns <= self.elapsed_ns {
            return Ok(());
        }
        if target_ns > self.limit_ns {
            self.elapsed_ns = self.limit_ns;
            self.limit_exceeded = true;
            return Err(RuntimeError::new("WASM-OJ logical time budget exhausted"));
        }
        self.elapsed_ns = target_ns;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(crate) struct VirtualClock {
    state: Arc<Mutex<VirtualClockState>>,
}

impl VirtualClock {
    pub(crate) fn new(config: &DeterminismConfig, logical_time_limit_ms: u64) -> Self {
        Self {
            state: Arc::new(Mutex::new(VirtualClockState {
                epoch_ns: config
                    .realtime_epoch_ms
                    .checked_mul(1_000_000)
                    .expect("validated realtime epoch fits a WASI timestamp"),
                step_ns: config.clock_step_ns,
                elapsed_ns: 0,
                limit_ns: logical_time_limit_ms
                    .checked_mul(1_000_000)
                    .expect("validated logical time limit fits a JavaScript safe integer"),
                limit_exceeded: false,
            })),
        }
    }

    pub(crate) fn unbounded(config: &DeterminismConfig) -> Self {
        Self {
            state: Arc::new(Mutex::new(VirtualClockState {
                epoch_ns: config
                    .realtime_epoch_ms
                    .checked_mul(1_000_000)
                    .expect("compiler realtime epoch fits a WASI timestamp"),
                step_ns: config.clock_step_ns,
                elapsed_ns: 0,
                limit_ns: u64::MAX,
                limit_exceeded: false,
            })),
        }
    }

    fn observe(&self, clock_id: u32) -> Result<u64, RuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| RuntimeError::new(error.to_string()))?;
        let value = state.value(clock_id)?;
        let target = state
            .elapsed_ns
            .checked_add(state.step_ns)
            .ok_or_else(|| RuntimeError::new("WASM-OJ virtual clock overflowed"))?;
        state.advance_to(target)?;
        Ok(value)
    }

    fn advance(&self, duration_ns: u64) -> Result<(), RuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| RuntimeError::new(error.to_string()))?;
        let target = state.elapsed_ns.saturating_add(duration_ns);
        state.advance_to(target)
    }

    fn advance_to(&self, target_ns: u64) -> Result<(), RuntimeError> {
        self.state
            .lock()
            .map_err(|error| RuntimeError::new(error.to_string()))?
            .advance_to(target_ns)
    }

    fn deadline(
        &self,
        clock: wasmer_wasix::wasmer_wasix_types::wasi::SubscriptionClock,
    ) -> Result<u64, i32> {
        let state = self.state.lock().map_err(|_| Errno::Io as i32)?;
        if clock.clock_id != Clockid::Realtime && clock.clock_id != Clockid::Monotonic {
            return Err(Errno::Inval as i32);
        }
        if clock
            .flags
            .contains(Subclockflags::SUBSCRIPTION_CLOCK_ABSTIME)
        {
            let target = if clock.clock_id == Clockid::Realtime {
                clock.timeout.saturating_sub(state.epoch_ns)
            } else {
                clock.timeout
            };
            Ok(target.max(state.elapsed_ns))
        } else {
            Ok(state.elapsed_ns.saturating_add(clock.timeout))
        }
    }

    pub(crate) fn elapsed_ns(&self) -> Result<u64, RunError> {
        Ok(self
            .state
            .lock()
            .map_err(|error| RunError::Runtime(error.to_string()))?
            .elapsed_ns)
    }

    pub(crate) fn limit_exceeded(&self) -> Result<bool, RunError> {
        Ok(self
            .state
            .lock()
            .map_err(|error| RunError::Runtime(error.to_string()))?
            .limit_exceeded)
    }
}

pub struct DeterministicEnv {
    memory: Arc<Mutex<Option<Memory>>>,
    random: Mutex<DeterministicRandom>,
    clock: VirtualClock,
}

#[derive(Debug)]
struct DeterministicRandom {
    startup: SplitMix64,
    startup_remaining: u64,
    user: SplitMix64,
}

impl DeterministicRandom {
    fn fill(&mut self, output: &mut [u8]) {
        let startup_length = usize::try_from(self.startup_remaining.min(output.len() as u64))
            .expect("startup entropy chunk fits usize");
        self.startup.fill(&mut output[..startup_length]);
        self.startup_remaining = self.startup_remaining.saturating_sub(startup_length as u64);
        self.user.fill(&mut output[startup_length..]);
    }
}

struct SetTimesEnv {
    original: Function,
    clock: VirtualClock,
}

struct PollEnv {
    original: Option<Function>,
    memory: Arc<Mutex<Option<Memory>>>,
    clock: VirtualClock,
}

thread_local! {
    static PROBING_READINESS: Cell<bool> = const { Cell::new(false) };
}

/// Whether the current `poll_oneoff` only probes descriptor readiness because
/// its clock subscriptions are resolved on the virtual clock afterwards.
#[cfg(target_arch = "wasm32")]
pub(crate) fn probing_readiness() -> bool {
    PROBING_READINESS.with(Cell::get)
}

#[derive(Clone, Copy)]
struct ClockSubscription {
    subscription: Subscription,
    deadline_ns: u64,
}

fn call_original_poll<M: MemorySize>(
    env: &mut FunctionEnvMut<PollEnv>,
    subscriptions: WasmPtr<Subscription, M>,
    events: WasmPtr<Event, M>,
    subscription_count: M::Offset,
    event_count: WasmPtr<M::Offset, M>,
) -> Result<i32, RuntimeError> {
    let Some(original) = env.data().original.clone() else {
        return Ok(Errno::Notsup as i32);
    };
    let pointer = |offset: u64| {
        if M::is_64bit() {
            Value::I64(offset as i64)
        } else {
            Value::I32(offset as i32)
        }
    };
    let results = original.call(
        env,
        &[
            pointer(subscriptions.offset().into()),
            pointer(events.offset().into()),
            pointer(subscription_count.into()),
            pointer(event_count.offset().into()),
        ],
    )?;
    match results.as_ref() {
        [Value::I32(errno)] => Ok(*errno),
        _ => Err(RuntimeError::new(
            "WASI poll_oneoff returned an invalid result",
        )),
    }
}

fn deterministic_poll_oneoff<M: MemorySize>(
    mut env: FunctionEnvMut<PollEnv>,
    subscriptions: WasmPtr<Subscription, M>,
    events: WasmPtr<Event, M>,
    subscription_count: M::Offset,
    event_count: WasmPtr<M::Offset, M>,
) -> Result<i32, RuntimeError> {
    let memory = env
        .data()
        .memory
        .lock()
        .map_err(|error| RuntimeError::new(error.to_string()))?
        .clone();
    let Some(memory) = memory else {
        return Ok(Errno::Fault as i32);
    };
    let view = memory.view(&env);
    let input = subscriptions
        .slice(&view, subscription_count)
        .map_err(|error| RuntimeError::new(error.to_string()))?;
    let mut originals = Vec::with_capacity(input.len() as usize);
    let mut clock_subscriptions = Vec::new();
    let mut has_non_clock = false;
    for index in 0..input.len() {
        let subscription = input
            .index(index)
            .read()
            .map_err(|error| RuntimeError::new(error.to_string()))?;
        originals.push(subscription);
        if subscription.type_ == Eventtype::Clock {
            let clock = unsafe { subscription.data.clock };
            let deadline_ns = match env.data().clock.deadline(clock) {
                Ok(value) => value,
                Err(errno) => return Ok(errno),
            };
            clock_subscriptions.push(ClockSubscription {
                subscription,
                deadline_ns,
            });
        } else {
            has_non_clock = true;
        }
    }

    if clock_subscriptions.is_empty() {
        return call_original_poll(
            &mut env,
            subscriptions,
            events,
            subscription_count,
            event_count,
        );
    }

    if has_non_clock && env.data().original.is_some() {
        for (index, original) in originals.iter().copied().enumerate() {
            if original.type_ != Eventtype::Clock {
                continue;
            }
            let mut clock = unsafe { original.data.clock };
            clock.timeout = 1;
            clock.flags = Subclockflags::from_bits_preserve(0);
            input
                .index(index as u64)
                .write(Subscription {
                    data: SubscriptionUnion { clock },
                    ..original
                })
                .map_err(|error| RuntimeError::new(error.to_string()))?;
        }
        PROBING_READINESS.with(|probing| probing.set(true));
        let probe = call_original_poll(
            &mut env,
            subscriptions,
            events,
            subscription_count,
            event_count,
        );
        PROBING_READINESS.with(|probing| probing.set(false));
        let restore_view = memory.view(&env);
        let restore_input = subscriptions
            .slice(&restore_view, subscription_count)
            .map_err(|error| RuntimeError::new(error.to_string()))?;
        for (index, original) in originals.iter().copied().enumerate() {
            restore_input
                .index(index as u64)
                .write(original)
                .map_err(|error| RuntimeError::new(error.to_string()))?;
        }
        let errno = probe?;
        if errno != Errno::Success as i32 {
            return Ok(errno);
        }

        let count = event_count
            .read(&restore_view)
            .map_err(|error| RuntimeError::new(error.to_string()))?
            .into();
        let output = events
            .slice(&restore_view, subscription_count)
            .map_err(|error| RuntimeError::new(error.to_string()))?;
        let mut fd_events = 0_u64;
        for index in 0..count {
            let event = output
                .index(index)
                .read()
                .map_err(|error| RuntimeError::new(error.to_string()))?;
            if event.type_ == Eventtype::Clock {
                continue;
            }
            output
                .index(fd_events)
                .write(event)
                .map_err(|error| RuntimeError::new(error.to_string()))?;
            fd_events += 1;
        }
        if fd_events > 0 {
            event_count
                .write(
                    &restore_view,
                    M::Offset::try_from(fd_events).map_err(|_| {
                        RuntimeError::new("deterministic poll event count exceeds guest range")
                    })?,
                )
                .map_err(|error| RuntimeError::new(error.to_string()))?;
            return Ok(Errno::Success as i32);
        }
    }

    let deadline_ns = clock_subscriptions
        .iter()
        .map(|subscription| subscription.deadline_ns)
        .min()
        .expect("clock subscription list is non-empty");
    env.data().clock.advance_to(deadline_ns)?;
    let elapsed_ns = env
        .data()
        .clock
        .state
        .lock()
        .map_err(|error| RuntimeError::new(error.to_string()))?
        .elapsed_ns;
    let final_view = memory.view(&env);
    let output = events
        .slice(&final_view, subscription_count)
        .map_err(|error| RuntimeError::new(error.to_string()))?;
    let mut written = 0_u64;
    for clock in clock_subscriptions {
        if clock.deadline_ns > elapsed_ns {
            continue;
        }
        output
            .index(written)
            .write(Event {
                userdata: clock.subscription.userdata,
                error: Errno::Success,
                type_: Eventtype::Clock,
                u: EventUnion { clock: 0 },
            })
            .map_err(|error| RuntimeError::new(error.to_string()))?;
        written += 1;
    }
    event_count
        .write(
            &final_view,
            M::Offset::try_from(written).map_err(|_| {
                RuntimeError::new("deterministic poll event count exceeds guest range")
            })?,
        )
        .map_err(|error| RuntimeError::new(error.to_string()))?;
    Ok(Errno::Success as i32)
}

fn deterministic_poll_oneoff_32(
    env: FunctionEnvMut<PollEnv>,
    subscriptions: WasmPtr<Subscription, Memory32>,
    events: WasmPtr<Event, Memory32>,
    subscription_count: u32,
    event_count: WasmPtr<u32, Memory32>,
) -> Result<i32, RuntimeError> {
    deterministic_poll_oneoff(env, subscriptions, events, subscription_count, event_count)
}

fn deterministic_poll_oneoff_64(
    env: FunctionEnvMut<PollEnv>,
    subscriptions: WasmPtr<Subscription, Memory64>,
    events: WasmPtr<Event, Memory64>,
    subscription_count: u64,
    event_count: WasmPtr<u64, Memory64>,
) -> Result<i32, RuntimeError> {
    deterministic_poll_oneoff(env, subscriptions, events, subscription_count, event_count)
}

fn write_u64<M: MemorySize>(
    env: &FunctionEnvMut<DeterministicEnv>,
    pointer: WasmPtr<u64, M>,
    value: u64,
) -> i32 {
    let Ok(memory) = env.data().memory.lock() else {
        return 1;
    };
    let Some(memory) = memory.as_ref() else {
        return 1;
    };
    pointer
        .write(&memory.view(env), value)
        .map(|_| 0)
        .unwrap_or(1)
}

fn write_u32<M: MemorySize>(
    env: &FunctionEnvMut<DeterministicEnv>,
    pointer: WasmPtr<u32, M>,
    value: u32,
) -> i32 {
    let Ok(memory) = env.data().memory.lock() else {
        return 1;
    };
    let Some(memory) = memory.as_ref() else {
        return 1;
    };
    pointer
        .write(&memory.view(env), value)
        .map(|_| 0)
        .unwrap_or(1)
}

fn clock_time_get_32(
    env: FunctionEnvMut<DeterministicEnv>,
    clock_id: u32,
    _precision: u64,
    result: WasmPtr<u64, Memory32>,
) -> Result<i32, RuntimeError> {
    if !VirtualClockState::supports(clock_id) {
        return Ok(Errno::Inval as i32);
    }
    let value = env.data().clock.observe(clock_id)?;
    Ok(write_u64(&env, result, value))
}

fn clock_time_get_64(
    env: FunctionEnvMut<DeterministicEnv>,
    clock_id: u32,
    _precision: u64,
    result: WasmPtr<u64, Memory64>,
) -> Result<i32, RuntimeError> {
    if !VirtualClockState::supports(clock_id) {
        return Ok(Errno::Inval as i32);
    }
    let value = env.data().clock.observe(clock_id)?;
    Ok(write_u64(&env, result, value))
}

fn clock_res_get_32(
    env: FunctionEnvMut<DeterministicEnv>,
    clock_id: u32,
    result: WasmPtr<u64, Memory32>,
) -> i32 {
    if !VirtualClockState::supports(clock_id) {
        return Errno::Inval as i32;
    }
    let resolution = match env.data().clock.state.lock() {
        Ok(clock) => clock.step_ns,
        Err(_) => return 1,
    };
    write_u64(&env, result, resolution)
}

fn clock_res_get_64(
    env: FunctionEnvMut<DeterministicEnv>,
    clock_id: u32,
    result: WasmPtr<u64, Memory64>,
) -> i32 {
    if !VirtualClockState::supports(clock_id) {
        return Errno::Inval as i32;
    }
    let resolution = match env.data().clock.state.lock() {
        Ok(clock) => clock.step_ns,
        Err(_) => return 1,
    };
    write_u64(&env, result, resolution)
}

fn random_get<M: MemorySize>(
    env: FunctionEnvMut<DeterministicEnv>,
    result: WasmPtr<u8, M>,
    length: M::Offset,
) -> i32 {
    let Ok(memory) = env.data().memory.lock() else {
        return 1;
    };
    let Some(memory) = memory.as_ref() else {
        return 1;
    };
    let view = memory.view(&env);
    let Ok(destination) = result.slice(&view, length) else {
        return 1;
    };

    let Ok(mut random) = env.data().random.lock() else {
        return 1;
    };
    let mut chunk = [0_u8; 4_096];
    let mut written = 0_u64;
    while written < destination.len() {
        let end = written
            .saturating_add(chunk.len() as u64)
            .min(destination.len());
        let chunk_length = usize::try_from(end - written).expect("random chunk length fits usize");
        random.fill(&mut chunk[..chunk_length]);
        if destination
            .subslice(written..end)
            .write_slice(&chunk[..chunk_length])
            .is_err()
        {
            return 1;
        }
        written = end;
    }
    0
}

fn random_get_32(
    env: FunctionEnvMut<DeterministicEnv>,
    result: WasmPtr<u8, Memory32>,
    length: u32,
) -> i32 {
    random_get(env, result, length)
}

fn random_get_64(
    env: FunctionEnvMut<DeterministicEnv>,
    result: WasmPtr<u8, Memory64>,
    length: u64,
) -> i32 {
    random_get(env, result, length)
}

fn thread_id_32(env: FunctionEnvMut<DeterministicEnv>, result: WasmPtr<u32, Memory32>) -> i32 {
    write_u32(&env, result, 1)
}

fn thread_id_64(env: FunctionEnvMut<DeterministicEnv>, result: WasmPtr<u32, Memory64>) -> i32 {
    write_u32(&env, result, 1)
}

fn thread_parallelism_32(
    env: FunctionEnvMut<DeterministicEnv>,
    result: WasmPtr<u32, Memory32>,
) -> i32 {
    write_u32(&env, result, 1)
}

fn thread_parallelism_64(
    env: FunctionEnvMut<DeterministicEnv>,
    result: WasmPtr<u64, Memory64>,
) -> i32 {
    write_u64(&env, result, 1)
}

fn thread_sleep(
    env: FunctionEnvMut<DeterministicEnv>,
    duration_ns: u64,
) -> Result<i32, RuntimeError> {
    env.data().clock.advance(duration_ns)?;
    Ok(0)
}

fn deterministic_fd_filestat_set_times(
    mut env: FunctionEnvMut<SetTimesEnv>,
    fd: i32,
    atime: i64,
    mtime: i64,
    flags: i32,
) -> Result<i32, RuntimeError> {
    let Some((atime, mtime, flags)) = deterministic_set_times_arguments(&env, atime, mtime, flags)?
    else {
        return Ok(1);
    };
    call_original_errno(
        &mut env,
        &[
            Value::I32(fd),
            Value::I64(atime),
            Value::I64(mtime),
            Value::I32(flags),
        ],
    )
}

// The host function must retain the exact WASI import signature.
#[allow(clippy::too_many_arguments)]
fn deterministic_path_filestat_set_times_32(
    mut env: FunctionEnvMut<SetTimesEnv>,
    fd: i32,
    lookup_flags: i32,
    path: i32,
    path_length: i32,
    atime: i64,
    mtime: i64,
    flags: i32,
) -> Result<i32, RuntimeError> {
    let Some((atime, mtime, flags)) = deterministic_set_times_arguments(&env, atime, mtime, flags)?
    else {
        return Ok(1);
    };
    call_original_errno(
        &mut env,
        &[
            Value::I32(fd),
            Value::I32(lookup_flags),
            Value::I32(path),
            Value::I32(path_length),
            Value::I64(atime),
            Value::I64(mtime),
            Value::I32(flags),
        ],
    )
}

// The host function must retain the exact WASIX64 import signature.
#[allow(clippy::too_many_arguments)]
fn deterministic_path_filestat_set_times_64(
    mut env: FunctionEnvMut<SetTimesEnv>,
    fd: i32,
    lookup_flags: i32,
    path: i64,
    path_length: i64,
    atime: i64,
    mtime: i64,
    flags: i32,
) -> Result<i32, RuntimeError> {
    let Some((atime, mtime, flags)) = deterministic_set_times_arguments(&env, atime, mtime, flags)?
    else {
        return Ok(1);
    };
    call_original_errno(
        &mut env,
        &[
            Value::I32(fd),
            Value::I32(lookup_flags),
            Value::I64(path),
            Value::I64(path_length),
            Value::I64(atime),
            Value::I64(mtime),
            Value::I32(flags),
        ],
    )
}

fn deterministic_set_times_arguments(
    env: &FunctionEnvMut<SetTimesEnv>,
    mut atime: i64,
    mut mtime: i64,
    flags: i32,
) -> Result<Option<(i64, i64, i32)>, RuntimeError> {
    let mut bits = flags as u32;
    let invalid = (bits & FSTFLAGS_ATIM != 0 && bits & FSTFLAGS_ATIM_NOW != 0)
        || (bits & FSTFLAGS_MTIM != 0 && bits & FSTFLAGS_MTIM_NOW != 0);
    if invalid || bits & (FSTFLAGS_ATIM_NOW | FSTFLAGS_MTIM_NOW) == 0 {
        return Ok(Some((atime, mtime, flags)));
    }

    if bits & FSTFLAGS_ATIM_NOW != 0 {
        atime = env.data().clock.observe(Clockid::Realtime as u32)? as i64;
        bits = (bits | FSTFLAGS_ATIM) & !FSTFLAGS_ATIM_NOW;
    }
    if bits & FSTFLAGS_MTIM_NOW != 0 {
        mtime = env.data().clock.observe(Clockid::Realtime as u32)? as i64;
        bits = (bits | FSTFLAGS_MTIM) & !FSTFLAGS_MTIM_NOW;
    }
    Ok(Some((atime, mtime, bits as i32)))
}

fn call_original_errno(
    env: &mut FunctionEnvMut<SetTimesEnv>,
    arguments: &[Value],
) -> Result<i32, RuntimeError> {
    let original = env.data().original.clone();
    let results = original.call(env, arguments)?;
    match results.as_ref() {
        [Value::I32(errno)] => Ok(*errno),
        _ => Err(RuntimeError::new(
            "WASI filestat setter returned an invalid result",
        )),
    }
}

fn attach_deterministic_set_times_32(
    store: &mut impl AsStoreMut,
    imports: &mut Imports,
    namespace: &str,
    clock: &VirtualClock,
) {
    if let Some(Extern::Function(original)) = imports.get_export(namespace, "fd_filestat_set_times")
    {
        let env = FunctionEnv::new(
            &mut *store,
            SetTimesEnv {
                original,
                clock: clock.clone(),
            },
        );
        imports.define(
            namespace,
            "fd_filestat_set_times",
            Function::new_typed_with_env(&mut *store, &env, deterministic_fd_filestat_set_times),
        );
    }
    if let Some(Extern::Function(original)) =
        imports.get_export(namespace, "path_filestat_set_times")
    {
        let env = FunctionEnv::new(
            &mut *store,
            SetTimesEnv {
                original,
                clock: clock.clone(),
            },
        );
        imports.define(
            namespace,
            "path_filestat_set_times",
            Function::new_typed_with_env(store, &env, deterministic_path_filestat_set_times_32),
        );
    }
}

fn attach_deterministic_set_times_64(
    store: &mut impl AsStoreMut,
    imports: &mut Imports,
    namespace: &str,
    clock: &VirtualClock,
) {
    if let Some(Extern::Function(original)) = imports.get_export(namespace, "fd_filestat_set_times")
    {
        let env = FunctionEnv::new(
            &mut *store,
            SetTimesEnv {
                original,
                clock: clock.clone(),
            },
        );
        imports.define(
            namespace,
            "fd_filestat_set_times",
            Function::new_typed_with_env(&mut *store, &env, deterministic_fd_filestat_set_times),
        );
    }
    if let Some(Extern::Function(original)) =
        imports.get_export(namespace, "path_filestat_set_times")
    {
        let env = FunctionEnv::new(
            &mut *store,
            SetTimesEnv {
                original,
                clock: clock.clone(),
            },
        );
        imports.define(
            namespace,
            "path_filestat_set_times",
            Function::new_typed_with_env(store, &env, deterministic_path_filestat_set_times_64),
        );
    }
}

fn attach_deterministic_poll_32(
    store: &mut impl AsStoreMut,
    imports: &mut Imports,
    namespace: &str,
    memory: &Arc<Mutex<Option<Memory>>>,
    clock: &VirtualClock,
) {
    let original = match imports.get_export(namespace, "poll_oneoff") {
        Some(Extern::Function(function)) => Some(function),
        _ => None,
    };
    let env = FunctionEnv::new(
        &mut *store,
        PollEnv {
            original,
            memory: memory.clone(),
            clock: clock.clone(),
        },
    );
    imports.define(
        namespace,
        "poll_oneoff",
        Function::new_typed_with_env(store, &env, deterministic_poll_oneoff_32),
    );
}

fn attach_deterministic_poll_64(
    store: &mut impl AsStoreMut,
    imports: &mut Imports,
    namespace: &str,
    memory: &Arc<Mutex<Option<Memory>>>,
    clock: &VirtualClock,
) {
    let original = match imports.get_export(namespace, "poll_oneoff") {
        Some(Extern::Function(function)) => Some(function),
        _ => None,
    };
    let env = FunctionEnv::new(
        &mut *store,
        PollEnv {
            original,
            memory: memory.clone(),
            clock: clock.clone(),
        },
    );
    imports.define(
        namespace,
        "poll_oneoff",
        Function::new_typed_with_env(store, &env, deterministic_poll_oneoff_64),
    );
}

pub fn attach_deterministic_imports(
    store: &mut impl AsStoreMut,
    imports: &mut Imports,
    memory: Arc<Mutex<Option<Memory>>>,
    config: &DeterminismConfig,
    clock: VirtualClock,
    startup_entropy_bytes: u64,
) {
    crate::stdio::attach_redirected_stdio(store, imports, &memory);
    let poll_memory = memory.clone();
    let env = FunctionEnv::new(
        store,
        DeterministicEnv {
            memory,
            random: Mutex::new(DeterministicRandom {
                startup: SplitMix64 {
                    state: 0x464f_5247_455f_474f,
                },
                startup_remaining: startup_entropy_bytes,
                user: SplitMix64 {
                    state: config.random_seed,
                },
            }),
            clock: clock.clone(),
        },
    );

    for namespace in ["wasi_snapshot_preview1", "wasix_32v1"] {
        imports.define(
            namespace,
            "clock_time_get",
            Function::new_typed_with_env(store, &env, clock_time_get_32),
        );
        imports.define(
            namespace,
            "clock_res_get",
            Function::new_typed_with_env(store, &env, clock_res_get_32),
        );
        imports.define(
            namespace,
            "random_get",
            Function::new_typed_with_env(store, &env, random_get_32),
        );
        attach_deterministic_poll_32(store, imports, namespace, &poll_memory, &clock);
        attach_deterministic_set_times_32(store, imports, namespace, &clock);
    }
    imports.define(
        "wasix_32v1",
        "thread_id",
        Function::new_typed_with_env(store, &env, thread_id_32),
    );
    imports.define(
        "wasix_32v1",
        "thread_parallelism",
        Function::new_typed_with_env(store, &env, thread_parallelism_32),
    );
    imports.define(
        "wasix_32v1",
        "thread_sleep",
        Function::new_typed_with_env(store, &env, thread_sleep),
    );
    imports.define(
        "wasix_64v1",
        "clock_time_get",
        Function::new_typed_with_env(store, &env, clock_time_get_64),
    );
    imports.define(
        "wasix_64v1",
        "clock_res_get",
        Function::new_typed_with_env(store, &env, clock_res_get_64),
    );
    imports.define(
        "wasix_64v1",
        "random_get",
        Function::new_typed_with_env(store, &env, random_get_64),
    );
    attach_deterministic_poll_64(store, imports, "wasix_64v1", &poll_memory, &clock);
    attach_deterministic_set_times_64(store, imports, "wasix_64v1", &clock);
    imports.define(
        "wasix_64v1",
        "thread_id",
        Function::new_typed_with_env(store, &env, thread_id_64),
    );
    imports.define(
        "wasix_64v1",
        "thread_parallelism",
        Function::new_typed_with_env(store, &env, thread_parallelism_64),
    );
    imports.define(
        "wasix_64v1",
        "thread_sleep",
        Function::new_typed_with_env(store, &env, thread_sleep),
    );
}

pub(crate) fn attach_interactive_deterministic_imports(
    store: &mut impl AsStoreMut,
    imports: &mut Imports,
    memory: Arc<Mutex<Option<Memory>>>,
    config: &DeterminismConfig,
    clock: VirtualClock,
    startup_entropy_bytes: u64,
) {
    attach_deterministic_imports(store, imports, memory, config, clock, startup_entropy_bytes);
    for (source, target, names) in [
        (
            "wasi_snapshot_preview1",
            INTERACTIVE_WASIP1_DETERMINISTIC_NAMESPACE,
            &[
                "clock_res_get",
                "clock_time_get",
                "fd_filestat_set_times",
                "path_filestat_set_times",
                "poll_oneoff",
                "random_get",
            ][..],
        ),
        (
            "wasix_32v1",
            INTERACTIVE_WASIX32_DETERMINISTIC_NAMESPACE,
            &[
                "clock_res_get",
                "clock_time_get",
                "fd_filestat_set_times",
                "path_filestat_set_times",
                "poll_oneoff",
                "random_get",
                "thread_id",
                "thread_parallelism",
                "thread_sleep",
            ][..],
        ),
        (
            "wasix_64v1",
            INTERACTIVE_WASIX64_DETERMINISTIC_NAMESPACE,
            &[
                "clock_res_get",
                "clock_time_get",
                "fd_filestat_set_times",
                "path_filestat_set_times",
                "poll_oneoff",
                "random_get",
                "thread_id",
                "thread_parallelism",
                "thread_sleep",
            ][..],
        ),
    ] {
        for name in names {
            if let Some(export) = imports.get_export(source, name) {
                imports.define(target, name, export);
            }
        }
    }
}
