use crate::{ResourcePolicy, RunError, RunRequest, RunResult};
use std::collections::BTreeMap;

pub(crate) const MAX_MOUNTED_FILES: usize = 32_768;
pub(crate) const MAX_MOUNTED_FILE_BYTES: usize = 256 * 1024 * 1024;
pub(crate) const MAX_MOUNTED_FILES_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_FILESYSTEM_WRITE_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_FILESYSTEM_ENTRIES: u64 = 65_536;
pub(crate) const MAX_LOGICAL_TIME_LIMIT_MS: u64 = 9_007_199_254;
pub(crate) const MAX_REALTIME_EPOCH_MS: u64 = 18_446_744_073_000;
pub(crate) const MAX_CLOCK_STEP_NS: u64 = 1_000_000_000;

#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
pub(crate) mod web_interactive;
#[cfg(target_arch = "wasm32")]
pub(crate) mod web_runtime;

pub fn run(request: RunRequest) -> Result<RunResult, RunError> {
    validate(&request)?;
    #[cfg(not(target_arch = "wasm32"))]
    return native::run(request);
    #[cfg(target_arch = "wasm32")]
    return web::run(request, |_| Ok(()));
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn run_observed(
    request: RunRequest,
    on_execution: impl FnMut(bool) -> Result<(), RunError>,
) -> Result<RunResult, RunError> {
    validate(&request)?;
    web::run(request, on_execution)
}

fn validate(request: &RunRequest) -> Result<(), RunError> {
    validate_resource_policy(&request.resources, "")?;
    validate_mounted_files(&request.files, "")?;
    validate_determinism(&request.determinism)?;
    if request.startup_entropy_bytes > 4_096 {
        return Err(RunError::InvalidRequest(
            "startupEntropyBytes must be at most 4096".to_string(),
        ));
    }
    if let Some(cwd) = &request.cwd
        && !crate::filesystem::is_normalized_guest_path(cwd)
    {
        return Err(RunError::InvalidRequest(
            "cwd must be an absolute normalized guest path".to_string(),
        ));
    }
    if request.output_paths.len() > 256 {
        return Err(RunError::InvalidRequest(
            "outputPaths may contain at most 256 entries".to_string(),
        ));
    }
    let mut preceding: Option<&str> = None;
    for path in &request.output_paths {
        if !crate::filesystem::is_normalized_guest_path(path) || path == "/" {
            return Err(RunError::InvalidRequest(format!(
                "output path must be an absolute normalized file path: {path}"
            )));
        }
        if preceding.is_some_and(|value| value >= path.as_str()) {
            return Err(RunError::InvalidRequest(
                "outputPaths must be sorted and unique".to_string(),
            ));
        }
        preceding = Some(path);
    }
    Ok(())
}

pub(crate) fn validate_determinism(determinism: &crate::DeterminismConfig) -> Result<(), RunError> {
    if determinism.random_seed > u32::MAX as u64 {
        return Err(RunError::InvalidRequest(
            "randomSeed must fit an unsigned 32-bit integer".to_string(),
        ));
    }
    if determinism.realtime_epoch_ms > MAX_REALTIME_EPOCH_MS {
        return Err(RunError::InvalidRequest(format!(
            "realtimeEpochMs must be in 0..={MAX_REALTIME_EPOCH_MS}"
        )));
    }
    if determinism.clock_step_ns == 0 || determinism.clock_step_ns > MAX_CLOCK_STEP_NS {
        return Err(RunError::InvalidRequest(format!(
            "clockStepNs must be in 1..={MAX_CLOCK_STEP_NS}"
        )));
    }
    Ok(())
}

pub(crate) fn validate_resource_policy(
    resources: &ResourcePolicy,
    label: &str,
) -> Result<(), RunError> {
    let prefix = if label.is_empty() {
        String::new()
    } else {
        format!("{label} ")
    };
    if resources.instruction_budget == 0 || resources.instruction_budget > i64::MAX as u64 {
        return Err(RunError::InvalidRequest(format!(
            "{prefix}instructionBudget must be in 1..=i64::MAX"
        )));
    }
    if resources.logical_time_limit_ms == 0
        || resources.logical_time_limit_ms > MAX_LOGICAL_TIME_LIMIT_MS
    {
        return Err(RunError::InvalidRequest(format!(
            "{prefix}logicalTimeLimitMs must be in 1..={MAX_LOGICAL_TIME_LIMIT_MS}"
        )));
    }
    if resources.memory_limit_bytes == 0 || !resources.memory_limit_bytes.is_multiple_of(65_536) {
        return Err(RunError::InvalidRequest(format!(
            "{prefix}memoryLimitBytes must be a positive multiple of 64 KiB"
        )));
    }
    if resources.output_limit_bytes == 0 || usize::try_from(resources.output_limit_bytes).is_err() {
        return Err(RunError::InvalidRequest(format!(
            "{prefix}outputLimitBytes is not representable on this host"
        )));
    }
    if resources.filesystem_write_limit_bytes == 0
        || resources.filesystem_write_limit_bytes > MAX_FILESYSTEM_WRITE_BYTES
        || usize::try_from(resources.filesystem_write_limit_bytes).is_err()
    {
        return Err(RunError::InvalidRequest(format!(
            "{prefix}filesystemWriteLimitBytes must be in 1..={MAX_FILESYSTEM_WRITE_BYTES}"
        )));
    }
    if resources.filesystem_entry_limit == 0
        || resources.filesystem_entry_limit > MAX_FILESYSTEM_ENTRIES
        || usize::try_from(resources.filesystem_entry_limit).is_err()
    {
        return Err(RunError::InvalidRequest(format!(
            "{prefix}filesystemEntryLimit must be in 1..={MAX_FILESYSTEM_ENTRIES}"
        )));
    }
    Ok(())
}

pub(crate) fn validate_mounted_files(
    files: &BTreeMap<String, serde_bytes::ByteBuf>,
    label: &str,
) -> Result<(), RunError> {
    let prefix = if label.is_empty() {
        String::new()
    } else {
        format!("{label} ")
    };
    if files.len() > MAX_MOUNTED_FILES {
        return Err(RunError::InvalidRequest(format!(
            "{prefix}mounted files exceed the {MAX_MOUNTED_FILES}-entry limit"
        )));
    }
    let mut total = 0usize;
    for (path, contents) in files {
        if contents.len() > MAX_MOUNTED_FILE_BYTES {
            return Err(RunError::InvalidRequest(format!(
                "{prefix}mounted file '{path}' exceeds {MAX_MOUNTED_FILE_BYTES} bytes"
            )));
        }
        total = total.checked_add(contents.len()).ok_or_else(|| {
            RunError::InvalidRequest(format!("{prefix}mounted file size overflows host range"))
        })?;
        if total > MAX_MOUNTED_FILES_BYTES {
            return Err(RunError::InvalidRequest(format!(
                "{prefix}mounted files exceed {MAX_MOUNTED_FILES_BYTES} total bytes"
            )));
        }
    }
    Ok(())
}

fn canonical_trap_message(message: &str) -> String {
    let mut root = message.trim().lines().next().unwrap_or_default().trim();
    loop {
        let unwrapped = ["RuntimeError: ", "js: ", "user: "]
            .iter()
            .find_map(|prefix| root.strip_prefix(prefix));
        let Some(unwrapped) = unwrapped else {
            break;
        };
        root = unwrapped.trim_start();
    }
    if root.is_empty() {
        "RuntimeError".to_string()
    } else {
        format!("RuntimeError: {root}")
    }
}

#[cfg(test)]
mod tests {
    use super::canonical_trap_message;

    #[test]
    fn removes_native_and_javascript_runtime_wrappers_from_traps() {
        let root = "WASM-OJ denied nondeterministic capability wasix_32v1.thread_spawn";
        assert_eq!(
            canonical_trap_message(&format!("RuntimeError: {root}")),
            format!("RuntimeError: {root}")
        );
        assert_eq!(
            canonical_trap_message(&format!("RuntimeError: js: RuntimeError: user: {root}")),
            format!("RuntimeError: {root}")
        );
        assert_eq!(
            canonical_trap_message(&format!(
                "RuntimeError: {root}\n    at <unnamed> (<module>[4]:0x1a4)"
            )),
            format!("RuntimeError: {root}")
        );
    }
}
