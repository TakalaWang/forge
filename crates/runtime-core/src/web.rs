use crate::run::web_interactive::{HostStreams, InteractiveSideRequest, run_side};
use crate::{
    GoCompilerSession as CoreGoCompilerSession, GoCompilerSessionConfig, GoCompilerSessionRequest,
    RunError, RunFailure, RunRequest, run_response_from_result,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn run_wasm_oj(request: JsValue, on_execution: js_sys::Function) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let request: RunRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|error| JsValue::from_str(&format!("invalid run request: {error}")))?;
    let response = run_response_from_result(crate::run::run_observed(request, |running| {
        on_execution
            .call1(&JsValue::UNDEFINED, &JsValue::from_bool(running))
            .map(|_| ())
            .map_err(|error| RunError::Runtime(format!("execution observer failed: {error:?}")))
    }));
    response
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| JsValue::from_str(&format!("failed to serialize run response: {error}")))
}

/// Process-local browser Go compiler session. Construction transfers and
/// hydrates the immutable package/stdlib exactly once; later calls carry only
/// monotonic source deltas and pipeline requests.
#[wasm_bindgen(js_name = GoCompilerSession)]
pub struct WebGoCompilerSession {
    inner: CoreGoCompilerSession,
}

#[wasm_bindgen(js_class = GoCompilerSession)]
impl WebGoCompilerSession {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<WebGoCompilerSession, JsValue> {
        console_error_panic_hook::set_once();
        let config: GoCompilerSessionConfig = serde_wasm_bindgen::from_value(config)
            .map_err(|error| JsValue::from_str(&format!("invalid Go compiler session: {error}")))?;
        let inner = CoreGoCompilerSession::new(config)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        Ok(Self { inner })
    }

    #[wasm_bindgen(getter)]
    pub fn digest(&self) -> String {
        self.inner.digest().to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> Result<u32, JsValue> {
        self.inner
            .generation()
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    #[wasm_bindgen(js_name = compilePipeline)]
    pub async fn compile_pipeline(&self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: GoCompilerSessionRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|error| JsValue::from_str(&format!("invalid Go compiler request: {error}")))?;
        let response = self
            .inner
            .compile_pipeline_response(request)
            .await
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        response
            .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
            .map_err(|error| {
                JsValue::from_str(&format!(
                    "failed to serialize Go compiler response: {error}"
                ))
            })
    }
}

/// Runs one side of an interactive session in the calling Worker. `read`,
/// `wait` and `write` block on the session's shared ring buffers; `poll`
/// checks the input without blocking; `close(fd)` closes the input (0) or
/// output (1) end when the guest drops it.
#[wasm_bindgen]
pub fn run_interactive_side(
    request: JsValue,
    read: js_sys::Function,
    poll: js_sys::Function,
    wait: js_sys::Function,
    write: js_sys::Function,
    close: js_sys::Function,
    on_execution: js_sys::Function,
) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let request: InteractiveSideRequest =
        serde_wasm_bindgen::from_value(request).map_err(|error| {
            JsValue::from_str(&format!("invalid interactive side request: {error}"))
        })?;
    let response = match run_side(
        request,
        HostStreams::new(read, poll, wait, write, close),
        |running| {
            on_execution
                .call1(&JsValue::UNDEFINED, &JsValue::from_bool(running))
                .map(|_| ())
                .map_err(|error| RunError::Runtime(format!("execution observer failed: {error:?}")))
        },
    ) {
        Ok(result) => InteractiveSideResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => InteractiveSideResponse {
            ok: false,
            result: None,
            error: Some(RunFailure {
                code: error.code(),
                message: error.to_string(),
            }),
        },
    };
    response
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| {
            JsValue::from_str(&format!(
                "failed to serialize interactive side response: {error}"
            ))
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InteractiveSideResponse {
    ok: bool,
    result: Option<crate::run::web_interactive::InteractiveSideResult>,
    error: Option<RunFailure>,
}
