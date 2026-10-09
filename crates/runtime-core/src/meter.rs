#[cfg(target_arch = "wasm32")]
use js_sys::{BigInt, WebAssembly};
use meter_wasmparser::Operator;
use radix_wasm_instrument::gas_metering::{self, MemoryGrowCost, Rules};
use radix_wasm_instrument::utils::module_info::ModuleInfo;
use std::borrow::Cow;
use std::collections::BTreeMap;
use wasm_encoder::reencode::{Error as ReencodeError, Reencode};
use wasm_encoder::{Encode, Section};
#[cfg(target_arch = "wasm32")]
use wasmer::js::AsJs;
use wasmer::{AsStoreMut, Function, Global, Imports, Instance};

pub const METER_MODEL: &str = "weighted";
const METERING_MODULE: &str = "wasm_oj_metering";
const GAS_COUNTER_NAME: &str = "gas_counter";

#[derive(Debug)]
pub struct InstrumentedModule {
    pub wasm: Vec<u8>,
    /// Static counts of the original module's operators, matching WARK's
    /// `RunResult.operations` semantics. Meter-injected operators are excluded.
    pub operations: BTreeMap<String, u64>,
}

#[derive(Debug, Default)]
struct WeightedRules;

impl Rules for WeightedRules {
    fn instruction_cost(&self, instruction: &Operator) -> Option<u32> {
        weighted_instruction_cost(instruction)
    }

    fn memory_grow_cost(&self) -> MemoryGrowCost {
        MemoryGrowCost::Free
    }

    fn call_per_local_cost(&self) -> u32 {
        0
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum CostPoints {
    Remaining(u64),
    Exhausted,
}

#[derive(Clone, Debug)]
pub struct MeterState {
    gas_counter: Global,
}

pub fn instrument_wasm(wasm: &[u8], budget: u64) -> Result<InstrumentedModule, String> {
    let initial_budget = i64::try_from(budget)
        .map_err(|_| format!("budget {budget} exceeds the signed 64-bit metering range"))?;
    let runtime_sections = runtime_custom_sections(wasm)?;
    let executable = canonicalize_custom_sections(wasm)?;
    let operations = inspect_weighted_opcodes(&executable)?;
    let mut module = ModuleInfo::new(&executable)
        .map_err(|error| format!("failed to parse module for weighted metering: {error}"))?;
    let backend = gas_metering::mutable_global::Injector::new(METERING_MODULE, GAS_COUNTER_NAME);
    let metered = gas_metering::inject(&mut module, backend, &WeightedRules)
        .map_err(|error| format!("failed to inject weighted metering: {error}"))?;
    let mut metered = set_initial_meter_budget(&metered, initial_budget)?;
    for (name, data) in runtime_sections {
        let section = wasm_encoder::CustomSection {
            name: Cow::Owned(name),
            data: Cow::Owned(data),
        };
        metered.push(section.id());
        section.encode(&mut metered);
    }
    Ok(InstrumentedModule {
        wasm: metered,
        operations,
    })
}

#[derive(Debug)]
struct MeterInitializationError(String);

impl std::fmt::Display for MeterInitializationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for MeterInitializationError {}

/// Units a program may spend between safepoints.
pub const SAFEPOINT_INTERVAL: i64 = 1 << 20;
const SAFEPOINT_NAME: &str = "safepoint";

/// Final instrumentation pass: sets the meter's budget, adds the uncharged safepoint, and gives
/// every function that has a loop but no parameters or locals one unused `i32` local.
///
/// JavaScriptCore (Safari 26) never enters optimized code inside a loop of a function without
/// parameters or locals: its baseline tier asks to tier up on almost every iteration and keeps
/// running the slow path, so a metered empty loop runs about 20 times slower than in Chromium and
/// hits the wall deadline before its instruction budget. The local changes neither behaviour nor
/// cost.
///
/// JavaScriptCore also never stops a terminated Worker while it runs Wasm, only when it next
/// reaches a JavaScript checkpoint such as `Atomics.wait`. So the charge that opens every function
/// and loop body is inlined, and once the counter drops below a threshold it reaches a cold
/// function that traps on exhaustion, or calls the imported `wasm_oj_metering.safepoint` (which
/// the browser host turns into such a checkpoint) and lowers the threshold by
/// `SAFEPOINT_INTERVAL`. A call inside a hot loop makes the whole loop slower in JavaScriptCore and
/// V8 even when it never runs, so a loop body leaves the loop to reach it: each loop becomes
/// `block (loop (block (loop ...) br 2) safepoint, refund, br 0)`, and every branch out of it
/// skips the three new labels. Functions that use other kinds of labels keep the call inside the
/// loop. Every other block keeps radix's gas function. Exhaustion is exactly where it was, and
/// none of these instructions is charged.
struct MeterInitializer {
    budget: i64,
    parameterized_types: Vec<bool>,
    function_types: Vec<u32>,
    defined_functions: usize,
    original_types: u32,
    imported_functions: u32,
    imported_globals: u32,
    defined_globals: u32,
    import_section_written: bool,
}

impl MeterInitializer {
    fn new(budget: i64) -> Self {
        Self {
            budget,
            parameterized_types: Vec::new(),
            function_types: Vec::new(),
            defined_functions: 0,
            original_types: 0,
            imported_functions: 0,
            imported_globals: 0,
            defined_globals: 0,
            import_section_written: false,
        }
    }

    fn safepoint_type(&self) -> u32 {
        self.original_types
    }

    fn safepoint_function(&self) -> u32 {
        self.imported_functions
    }

    fn gas_function(&self) -> u32 {
        self.imported_functions + self.function_types.len() as u32
    }

    fn slow_function(&self) -> u32 {
        self.gas_function() + 1
    }

    fn gas_global(&self) -> u32 {
        self.imported_globals + self.defined_globals - 1
    }

    fn threshold_global(&self) -> u32 {
        self.imported_globals + self.defined_globals
    }

    fn safepoint_import(&self, imports: &mut wasm_encoder::ImportSection) {
        imports.import(
            METERING_MODULE,
            SAFEPOINT_NAME,
            wasm_encoder::EntityType::Function(self.safepoint_type()),
        );
    }

    fn slow_body(&self) -> wasm_encoder::Function {
        use wasm_encoder::Instruction::*;
        let gas = self.gas_global();
        let mut function = wasm_encoder::Function::new([(1, wasm_encoder::ValType::I64)]);
        for instruction in [
            GlobalGet(gas),
            I64Const(0),
            I64LtS,
            If(wasm_encoder::BlockType::Empty),
            I64Const(-1),
            GlobalSet(gas),
            Unreachable,
            End,
            GlobalGet(gas),
            I64Const(SAFEPOINT_INTERVAL),
            I64Sub,
            LocalTee(0),
            I64Const(0),
            LocalGet(0),
            I64Const(0),
            I64GtS,
            Select,
            GlobalSet(self.threshold_global()),
            Call(self.safepoint_function()),
            End,
        ] {
            function.instruction(&instruction);
        }
        function
    }

    /// Re-encodes a body, replacing the gas call that opens the function and each loop body with
    /// an inline charge and safepoint check.
    fn encode_body(
        &mut self,
        body: &wasmparser::FunctionBody<'_>,
        extra_local: bool,
    ) -> Result<wasm_encoder::Function, ReencodeError<MeterInitializationError>> {
        use wasm_encoder::Instruction::*;
        use wasmparser::Operator as Op;
        let mut function = self.new_function_with_parsed_locals(body)?;
        if extra_local {
            function = wasm_encoder::Function::new([(1, wasm_encoder::ValType::I32)]);
        }
        let original_gas = self.imported_functions + self.function_types.len() as u32 - 1;
        let gas = self.gas_global();
        let rotate = !has_other_labels(body)?;
        let mut frames: Vec<Option<i64>> = Vec::new();
        let mut head = Some(false);
        let mut pending = None;
        let adjust = |frames: &[Option<i64>], depth: u32| {
            let crossed = frames[frames.len() - depth as usize..]
                .iter()
                .filter(|frame| frame.is_some())
                .count();
            depth + 3 * crossed as u32
        };
        let mut operators = body.get_operators_reader()?;
        while !operators.eof() {
            let operator = operators.read()?;
            if let Some((cost, wrapped)) = pending.take() {
                if matches!(operator, Op::Call { function_index } if function_index == original_gas)
                {
                    for instruction in [
                        GlobalGet(gas),
                        I64Const(cost),
                        I64Sub,
                        GlobalSet(gas),
                        GlobalGet(gas),
                        GlobalGet(self.threshold_global()),
                        I64LtS,
                    ] {
                        function.instruction(&instruction);
                    }
                    if wrapped {
                        function.instruction(&BrIf(1));
                        if let Some(frame) = frames.last_mut() {
                            *frame = Some(cost);
                        }
                    } else {
                        function.instruction(&If(wasm_encoder::BlockType::Empty));
                        function.instruction(&Call(self.slow_function()));
                        function.instruction(&End);
                    }
                    continue;
                }
                function.instruction(&I64Const(cost));
            }
            let at_head = head.take();
            match operator {
                Op::I64Const { value } if at_head.is_some() => {
                    pending = Some((value, at_head == Some(true)));
                    continue;
                }
                Op::Loop { blockty } => {
                    let parameterized = match blockty {
                        wasmparser::BlockType::FuncType(ty) => self
                            .parameterized_types
                            .get(ty as usize)
                            .copied()
                            .unwrap_or(true),
                        _ => false,
                    };
                    let wrapped = rotate && !parameterized;
                    let blockty = self.block_type(blockty)?;
                    if wrapped {
                        function.instruction(&Block(blockty));
                        function.instruction(&Loop(wasm_encoder::BlockType::Empty));
                        function.instruction(&Block(wasm_encoder::BlockType::Empty));
                        frames.push(Some(0));
                    } else {
                        frames.push(None);
                    }
                    function.instruction(&Loop(blockty));
                    head = Some(wrapped);
                    continue;
                }
                Op::Block { .. } | Op::If { .. } | Op::Try { .. } | Op::TryTable { .. } => {
                    frames.push(None)
                }
                Op::End => {
                    if let Some(Some(cost)) = frames.pop() {
                        for instruction in [
                            End,
                            Br(2),
                            End,
                            Call(self.slow_function()),
                            GlobalGet(gas),
                            I64Const(cost),
                            I64Add,
                            GlobalSet(gas),
                            Br(0),
                            End,
                            Unreachable,
                            End,
                        ] {
                            function.instruction(&instruction);
                        }
                        continue;
                    }
                }
                Op::Br { relative_depth } if rotate => {
                    function.instruction(&Br(adjust(&frames, relative_depth)));
                    continue;
                }
                Op::BrIf { relative_depth } if rotate => {
                    function.instruction(&BrIf(adjust(&frames, relative_depth)));
                    continue;
                }
                Op::BrTable { targets } if rotate => {
                    let mut depths = Vec::new();
                    for target in targets.targets() {
                        depths.push(adjust(&frames, target?));
                    }
                    function
                        .instruction(&BrTable(depths.into(), adjust(&frames, targets.default())));
                    continue;
                }
                _ => {}
            }
            function.instruction(&self.instruction(operator)?);
        }
        Ok(function)
    }
}

/// Whether a body uses labels other than through `br`, `br_if` and `br_table`.
fn has_other_labels(
    body: &wasmparser::FunctionBody<'_>,
) -> Result<bool, wasmparser::BinaryReaderError> {
    use wasmparser::Operator as Op;
    let mut operators = body.get_operators_reader()?;
    while !operators.eof() {
        if matches!(
            operators.read()?,
            Op::Try { .. }
                | Op::TryTable { .. }
                | Op::Delegate { .. }
                | Op::Rethrow { .. }
                | Op::BrOnNull { .. }
                | Op::BrOnNonNull { .. }
                | Op::BrOnCast { .. }
                | Op::BrOnCastFail { .. }
                | Op::BrOnCastDescEq { .. }
                | Op::BrOnCastDescEqFail { .. }
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn meter_error(message: &str) -> ReencodeError<MeterInitializationError> {
    ReencodeError::UserError(MeterInitializationError(message.to_string()))
}

impl Reencode for MeterInitializer {
    type Error = MeterInitializationError;

    fn function_index(&mut self, func: u32) -> Result<u32, ReencodeError<Self::Error>> {
        Ok(if func >= self.imported_functions {
            func + 1
        } else {
            func
        })
    }

    fn intersperse_section_hook(
        &mut self,
        module: &mut wasm_encoder::Module,
        _after: Option<wasm_encoder::SectionId>,
        before: Option<wasm_encoder::SectionId>,
    ) -> Result<(), ReencodeError<Self::Error>> {
        use wasm_encoder::SectionId;
        if self.import_section_written
            || matches!(
                before,
                Some(SectionId::Custom | SectionId::Type | SectionId::Import)
            )
        {
            return Ok(());
        }
        let mut imports = wasm_encoder::ImportSection::new();
        self.safepoint_import(&mut imports);
        module.section(&imports);
        self.import_section_written = true;
        Ok(())
    }

    fn parse_type_section(
        &mut self,
        types: &mut wasm_encoder::TypeSection,
        section: wasmparser::TypeSectionReader<'_>,
    ) -> Result<(), ReencodeError<Self::Error>> {
        for group in section.clone() {
            for ty in group?.types() {
                self.parameterized_types
                    .push(match &ty.composite_type.inner {
                        wasmparser::CompositeInnerType::Func(function) => {
                            !function.params().is_empty()
                        }
                        _ => true,
                    });
            }
        }
        self.original_types = self.parameterized_types.len() as u32;
        wasm_encoder::reencode::utils::parse_type_section(self, types, section)?;
        types.ty().function([], []);
        Ok(())
    }

    fn parse_import_section(
        &mut self,
        imports: &mut wasm_encoder::ImportSection,
        section: wasmparser::ImportSectionReader<'_>,
    ) -> Result<(), ReencodeError<Self::Error>> {
        for import in section.clone().into_imports() {
            match import?.ty {
                wasmparser::TypeRef::Func(_) => self.imported_functions += 1,
                wasmparser::TypeRef::Global(_) => self.imported_globals += 1,
                _ => {}
            }
        }
        wasm_encoder::reencode::utils::parse_import_section(self, imports, section)?;
        self.safepoint_import(imports);
        self.import_section_written = true;
        Ok(())
    }

    fn parse_function_section(
        &mut self,
        functions: &mut wasm_encoder::FunctionSection,
        section: wasmparser::FunctionSectionReader<'_>,
    ) -> Result<(), ReencodeError<Self::Error>> {
        for function in section.clone() {
            self.function_types.push(function?);
        }
        if self.function_types.is_empty() {
            return Err(meter_error("instrumented module has no gas function"));
        }
        wasm_encoder::reencode::utils::parse_function_section(self, functions, section)?;
        functions.function(self.safepoint_type());
        Ok(())
    }

    fn parse_code_section(
        &mut self,
        code: &mut wasm_encoder::CodeSection,
        section: wasmparser::CodeSectionReader<'_>,
    ) -> Result<(), ReencodeError<Self::Error>> {
        wasm_encoder::reencode::utils::parse_code_section(self, code, section)?;
        code.function(&self.slow_body());
        Ok(())
    }

    fn parse_function_body(
        &mut self,
        code: &mut wasm_encoder::CodeSection,
        body: wasmparser::FunctionBody<'_>,
    ) -> Result<(), ReencodeError<Self::Error>> {
        let ordinal = self.defined_functions;
        self.defined_functions += 1;
        if ordinal + 1 == self.function_types.len() {
            return wasm_encoder::reencode::utils::parse_function_body(self, code, body);
        }
        let parameterized = self
            .function_types
            .get(ordinal)
            .and_then(|ty| self.parameterized_types.get(*ty as usize))
            .copied()
            .unwrap_or(true);
        let loops = has_loop(&body)?;
        let extra_local = !parameterized && body.get_locals_reader()?.get_count() == 0 && loops;
        let function = self.encode_body(&body, extra_local)?;
        code.function(&function);
        Ok(())
    }

    fn parse_global_section(
        &mut self,
        globals: &mut wasm_encoder::GlobalSection,
        section: wasmparser::GlobalSectionReader<'_>,
    ) -> Result<(), ReencodeError<Self::Error>> {
        self.defined_globals = section.count();
        let meter_ordinal = section
            .count()
            .checked_sub(1)
            .ok_or_else(|| meter_error("instrumented module has no meter global"))?;
        for (ordinal, global) in section.into_iter().enumerate() {
            let global = global?;
            if u32::try_from(ordinal).ok() == Some(meter_ordinal) {
                if global.ty.content_type != wasmparser::ValType::I64 || !global.ty.mutable {
                    return Err(meter_error(
                        "instrumented meter global has an unexpected type",
                    ));
                }
                globals.global(
                    self.global_type(global.ty)?,
                    &wasm_encoder::ConstExpr::i64_const(self.budget),
                );
            } else {
                wasm_encoder::reencode::utils::parse_global(self, globals, global)?;
            }
        }
        globals.global(
            wasm_encoder::GlobalType {
                val_type: wasm_encoder::ValType::I64,
                mutable: true,
                shared: false,
            },
            &wasm_encoder::ConstExpr::i64_const((self.budget - SAFEPOINT_INTERVAL).max(0)),
        );
        Ok(())
    }
}

fn set_initial_meter_budget(wasm: &[u8], budget: i64) -> Result<Vec<u8>, String> {
    validate_meter_global_position(wasm)?;
    let mut module = wasm_encoder::Module::new();
    MeterInitializer::new(budget)
        .parse_core_module(&mut module, wasmparser::Parser::new(0), wasm)
        .map_err(|error| format!("failed to initialize weighted meter: {error}"))?;
    Ok(module.finish())
}

fn has_loop(body: &wasmparser::FunctionBody<'_>) -> Result<bool, wasmparser::BinaryReaderError> {
    let mut operators = body.get_operators_reader()?;
    while !operators.eof() {
        if matches!(operators.read()?, wasmparser::Operator::Loop { .. }) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_meter_global_position(wasm: &[u8]) -> Result<(), String> {
    let mut imported_globals = 0_u32;
    let mut defined_globals = 0_u32;
    let mut exported_meter = None;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload.map_err(|error| format!("failed to inspect weighted meter: {error}"))? {
            wasmparser::Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import.map_err(|error| error.to_string())?;
                    if matches!(import.ty, wasmparser::TypeRef::Global(_)) {
                        imported_globals = imported_globals.saturating_add(1);
                    }
                }
            }
            wasmparser::Payload::GlobalSection(section) => defined_globals = section.count(),
            wasmparser::Payload::ExportSection(section) => {
                for export in section {
                    let export = export.map_err(|error| error.to_string())?;
                    if export.name == GAS_COUNTER_NAME
                        && export.kind == wasmparser::ExternalKind::Global
                    {
                        exported_meter = Some(export.index);
                    }
                }
            }
            _ => {}
        }
    }
    let expected = imported_globals
        .checked_add(defined_globals)
        .and_then(|count| count.checked_sub(1))
        .ok_or_else(|| "instrumented module has no defined meter global".to_string())?;
    if exported_meter != Some(expected) {
        return Err("instrumented meter is not the final defined global".to_string());
    }
    Ok(())
}

/// Index-bearing metadata becomes stale when the metering pass inserts
/// functions. The WASIX `dylink.0` section is runtime semantics, however, and
/// must be restored after instrumentation so dynamically linked modules remain
/// valid. Radix's encoder intentionally omits all custom sections.
fn canonicalize_custom_sections(wasm: &[u8]) -> Result<Vec<u8>, String> {
    #[derive(Debug)]
    struct ExecutableOnly;

    impl Reencode for ExecutableOnly {
        type Error = std::convert::Infallible;

        fn parse_custom_section(
            &mut self,
            _module: &mut wasm_encoder::Module,
            _section: wasmparser::CustomSectionReader<'_>,
        ) -> Result<(), ReencodeError<Self::Error>> {
            Ok(())
        }
    }

    let mut module = wasm_encoder::Module::new();
    ExecutableOnly
        .parse_core_module(&mut module, wasmparser::Parser::new(0), wasm)
        .map_err(|error| format!("failed to canonicalize executable sections: {error}"))?;
    Ok(module.finish())
}

fn runtime_custom_sections(wasm: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut sections = Vec::new();
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        let payload =
            payload.map_err(|error| format!("failed to inspect custom sections: {error}"))?;
        if let wasmparser::Payload::CustomSection(section) = payload
            && section.name() == "dylink.0"
        {
            sections.push((section.name().to_string(), section.data().to_vec()));
        }
    }
    Ok(sections)
}

fn inspect_weighted_opcodes(wasm: &[u8]) -> Result<BTreeMap<String, u64>, String> {
    let mut operations = BTreeMap::new();
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        let payload =
            payload.map_err(|error| format!("failed to inspect meter opcodes: {error}"))?;
        if let wasmparser::Payload::CodeSectionEntry(body) = payload {
            let reader = body
                .get_operators_reader()
                .map_err(|error| format!("failed to inspect function opcodes: {error}"))?;
            for operator in reader {
                let operator =
                    operator.map_err(|error| format!("failed to read function opcode: {error}"))?;
                let debug = format!("{operator:?}");
                let opcode = debug.split_whitespace().next().unwrap_or("UNKNOWN");
                operations
                    .entry(opcode.to_string())
                    .and_modify(|count| *count += 1)
                    .or_insert(1);
            }
        }
    }
    Ok(operations)
}

pub fn meter_state(instance: &Instance) -> Result<MeterState, String> {
    instance
        .exports
        .get_global(GAS_COUNTER_NAME)
        .cloned()
        .map(|gas_counter| MeterState { gas_counter })
        .map_err(|error| format!("instrumented module does not export its meter: {error}"))
}

pub fn remaining_points(
    store: &mut impl AsStoreMut,
    meter: &MeterState,
) -> Result<CostPoints, String> {
    #[cfg(not(target_arch = "wasm32"))]
    let value = meter
        .gas_counter
        .get(store)
        .i64()
        .ok_or_else(|| "metering global has the wrong type".to_string())?;

    #[cfg(target_arch = "wasm32")]
    let value = {
        let gas_counter: WebAssembly::Global = meter.gas_counter.as_jsvalue(store).into();
        i64::try_from(BigInt::from(gas_counter.value()))
            .map_err(|_| "metering global is outside the signed 64-bit range".to_string())?
    };

    if value < 0 {
        Ok(CostPoints::Exhausted)
    } else {
        Ok(CostPoints::Remaining(value as u64))
    }
}

/// Provides `wasm_oj_metering.safepoint`, which the meter calls every `SAFEPOINT_INTERVAL` units.
/// Natively it does nothing. In a browser it calls `Atomics.wait` with a value that never matches,
/// which returns at once; JavaScriptCore checks for Worker termination there, which it never does
/// inside Wasm, so `terminate()` stops a running program within one interval in WebKit too.
pub fn attach_safepoint(store: &mut impl AsStoreMut, imports: &mut Imports) {
    imports.define(
        METERING_MODULE,
        SAFEPOINT_NAME,
        Function::new_typed(store, safepoint),
    );
}

#[cfg(not(target_arch = "wasm32"))]
fn safepoint() {}

#[cfg(target_arch = "wasm32")]
fn safepoint() {
    thread_local! {
        static CHECKPOINT: Option<js_sys::Int32Array> = js_sys::Reflect::get(&js_sys::global(), &"SharedArrayBuffer".into())
            .ok()
            .filter(|constructor| constructor.is_function())
            .map(|_| js_sys::Int32Array::new(&js_sys::SharedArrayBuffer::new(4)));
    }
    CHECKPOINT.with(|checkpoint| {
        if let Some(checkpoint) = checkpoint {
            let _ = js_sys::Atomics::wait_with_timeout(checkpoint, 0, 1, 0.0);
        }
    });
}

fn weighted_instruction_cost(operator: &Operator) -> Option<u32> {
    let debug = format!("{operator:?}");
    weighted_opcode_cost(debug.split_whitespace().next().unwrap_or("UNKNOWN"))
}

fn weighted_opcode_cost(opcode: &str) -> Option<u32> {
    Some(wark_v03_opcode_cost(opcode))
}

/// Opcode cost model adapted from Binaryen's optimizer cost analysis and
/// preserved through WARK 0.3. WARK's 1000-point penalty for every operator
/// absent from the table, including future instructions, remains an explicit
/// compatibility rule.
fn wark_v03_opcode_cost(opcode: &str) -> u32 {
    match opcode {
        "LocalGet" | "Return" | "Unreachable" | "Nop" | "Drop" | "Try" => 0,
        "LocalSet" | "LocalTee" | "GlobalGet" => 1,
        "GlobalSet" => 2,
        "F32Load" | "F64Load" | "I32Load" | "I64Load" | "I32Load8S" | "I32Load8U"
        | "I32Load16S" | "I32Load16U" | "I64Load8S" | "I64Load8U" | "I64Load16S" | "I64Load16U"
        | "I64Load32S" | "I64Load32U" => 1,
        "I32AtomicLoad" | "I32AtomicLoad8U" | "I32AtomicLoad16U" | "I64AtomicLoad"
        | "I64AtomicLoad8U" | "I64AtomicLoad16U" | "I64AtomicLoad32U" => 11,
        "F32Store" | "F64Store" | "I32Store" | "I64Store" | "I32Store8" | "I32Store16"
        | "I64Store8" | "I64Store16" | "I64Store32" => 2,
        "I32AtomicStore" | "I32AtomicStore8" | "I32AtomicStore16" | "I64AtomicStore"
        | "I64AtomicStore8" | "I64AtomicStore16" | "I64AtomicStore32" => 12,
        "F32Const" | "F64Const" | "I32Const" | "I64Const" => 1,
        "F32ConvertI32S" | "F32ConvertI32U" | "F32ConvertI64S" | "F32ConvertI64U"
        | "F64ConvertI32S" | "F64ConvertI32U" | "F64ConvertI64S" | "F64ConvertI64U"
        | "I32ReinterpretF32" | "I64ReinterpretF64" | "F32ReinterpretI32" | "F64ReinterpretI64"
        | "I32WrapI64" | "I32Extend8S" | "I32Extend16S" | "I64Extend8S" | "I64Extend16S"
        | "I64Extend32S" | "I64ExtendI32U" | "I64ExtendI32S" | "F32Trunc" | "F64Trunc"
        | "I32TruncF32S" | "I32TruncF32U" | "I32TruncF64S" | "I32TruncF64U" | "I32TruncSatF32S"
        | "I32TruncSatF32U" | "I32TruncSatF64S" | "I32TruncSatF64U" | "I64TruncF32S"
        | "I64TruncF32U" | "I64TruncF64S" | "I64TruncF64U" | "I64TruncSatF32S"
        | "I64TruncSatF32U" | "I64TruncSatF64S" | "I64TruncSatF64U" | "F32DemoteF64"
        | "F64PromoteF32" | "I32Popcnt" | "I64Popcnt" | "I32Clz" | "I32Ctz" | "I64Clz"
        | "I64Ctz" | "F32Neg" | "F64Neg" | "F32Abs" | "F64Abs" | "F32Ceil" | "F64Ceil"
        | "F32Floor" | "F64Floor" | "F32Nearest" | "F64Nearest" | "I32Eqz" | "I64Eqz" => 1,
        "F32Sqrt" | "F64Sqrt" => 2,
        "F32x4Splat"
        | "F64x2Splat"
        | "I16x8Splat"
        | "I32x4Splat"
        | "I64x2Splat"
        | "I8x16Splat"
        | "V128Not"
        | "V128AnyTrue"
        | "F32x4Abs"
        | "F32x4Neg"
        | "F32x4Sqrt"
        | "F32x4Ceil"
        | "F32x4Floor"
        | "F32x4Trunc"
        | "F32x4Nearest"
        | "F64x2Abs"
        | "F64x2Neg"
        | "F64x2Sqrt"
        | "F64x2Ceil"
        | "F64x2Floor"
        | "F64x2Trunc"
        | "F64x2Nearest"
        | "I8x16Abs"
        | "I8x16Neg"
        | "I8x16AllTrue"
        | "I8x16Bitmask"
        | "I8x16Popcnt"
        | "I16x8Abs"
        | "I16x8Neg"
        | "I16x8AllTrue"
        | "I16x8Bitmask"
        | "I32x4Abs"
        | "I32x4Neg"
        | "I32x4AllTrue"
        | "I32x4Bitmask"
        | "I64x2Abs"
        | "I64x2Neg"
        | "I64x2AllTrue"
        | "I64x2Bitmask"
        | "F32x4ConvertI32x4S"
        | "F32x4ConvertI32x4U"
        | "I32x4TruncSatF32x4S"
        | "I32x4TruncSatF32x4U"
        | "F64x2ConvertLowI32x4S"
        | "F64x2ConvertLowI32x4U"
        | "I32x4TruncSatF64x2SZero"
        | "I32x4TruncSatF64x2UZero"
        | "I16x8ExtAddPairwiseI8x16S"
        | "I16x8ExtAddPairwiseI8x16U"
        | "I32x4ExtAddPairwiseI16x8S"
        | "I32x4ExtAddPairwiseI16x8U"
        | "I16x8ExtendHighI8x16S"
        | "I16x8ExtendLowI8x16S"
        | "I16x8ExtendHighI8x16U"
        | "I16x8ExtendLowI8x16U"
        | "I32x4ExtendHighI16x8S"
        | "I32x4ExtendLowI16x8S"
        | "I32x4ExtendHighI16x8U"
        | "I32x4ExtendLowI16x8U"
        | "I64x2ExtendHighI32x4S"
        | "I64x2ExtendLowI32x4S"
        | "I64x2ExtendHighI32x4U"
        | "I64x2ExtendLowI32x4U"
        | "F32x4DemoteF64x2Zero"
        | "F64x2PromoteLowF32x4"
        | "I32x4RelaxedTruncF32x4S"
        | "I32x4RelaxedTruncF32x4U"
        | "I32x4RelaxedTruncF64x2SZero"
        | "I32x4RelaxedTruncF64x2UZero" => 1,
        "I32Add" | "I32Sub" | "I64Add" | "I64Sub" | "F32Add" | "F32Sub" | "F64Add" | "F64Sub" => 1,
        "I32Mul" | "I64Mul" | "F32Mul" | "F64Mul" => 2,
        "I32DivS" | "I32DivU" | "I32RemS" | "I32RemU" | "I64DivS" | "I64DivU" | "I64RemS"
        | "I64RemU" | "F32Div" | "F64Div" => 3,
        "I32And" | "I32Or" | "I32Xor" | "I32Shl" | "I32ShrS" | "I32ShrU" | "I32Rotl"
        | "I32Rotr" | "I64And" | "I64Or" | "I64Xor" | "I64Shl" | "I64ShrS" | "I64ShrU"
        | "I64Rotl" | "I64Rotr" | "F32Copysign" | "F64Copysign" | "F32Min" | "F32Max"
        | "F64Min" | "F64Max" | "I32Eq" | "I32Ne" | "I32LtS" | "I32LtU" | "I32LeS" | "I32LeU"
        | "I32GtS" | "I32GtU" | "I32GeS" | "I32GeU" | "I64Eq" | "I64Ne" | "I64LtS" | "I64LtU"
        | "I64LeS" | "I64LeU" | "I64GtS" | "I64GtU" | "I64GeS" | "I64GeU" | "F32Eq" | "F32Ne"
        | "F32Lt" | "F32Le" | "F32Gt" | "F32Ge" | "F64Eq" | "F64Ne" | "F64Lt" | "F64Le"
        | "F64Gt" | "F64Ge" => 1,
        "Block" | "Loop" | "If" | "Else" | "End" | "Br" | "BrIf" | "BrTable" | "Select" => 1,
        "MemoryGrow" | "MemorySize" => 1,
        "MemoryInit" | "MemoryCopy" | "MemoryFill" => 6,
        "Call" => 4,
        "CallIndirect" => 6,
        "DataDrop" => 5,
        "Throw" => 100,
        _ => 1000,
    }
}

#[cfg(test)]
mod tests {
    use super::{METER_MODEL, SAFEPOINT_INTERVAL, instrument_wasm, weighted_opcode_cost};
    use crate::{DeterminismConfig, ExecutionTermination, ResourcePolicy, RunRequest};
    use std::borrow::Cow;
    use std::collections::BTreeMap;
    use wasm_encoder::{Encode, Section};
    use wasmparser::{ExternalKind, Parser, Payload, ValType};

    #[test]
    fn instrumentation_adds_the_metering_global() {
        let wasm =
            wat::parse_str("(module (memory (export \"memory\") 1) (func (export \"_start\")))")
                .unwrap();
        let metered = instrument_wasm(&wasm, 1_000_000).unwrap();
        let found = Parser::new(0)
            .parse_all(&metered.wasm)
            .filter_map(Result::ok)
            .any(|payload| {
                let Payload::ExportSection(section) = payload else {
                    return false;
                };
                section.into_iter().filter_map(Result::ok).any(|export| {
                    export.name == "gas_counter" && export.kind == ExternalKind::Global
                })
            });
        assert!(found);
        assert_eq!(METER_MODEL, "weighted");
    }

    #[test]
    fn current_wasi_atomic_fences_are_supported() {
        let wasm = wat::parse_str(
            "(module (memory (export \"memory\") 1) (func (export \"_start\") atomic.fence))",
        )
        .unwrap();
        instrument_wasm(&wasm, 1_000_000).unwrap();
    }

    #[test]
    fn module_name_sections_are_removed_before_instrumentation() {
        let wasm = wat::parse_str(
            "(module $quickjs (memory (export \"memory\") 1) (func (export \"_start\")))",
        )
        .unwrap();
        instrument_wasm(&wasm, 1_000_000).unwrap();
    }

    #[test]
    fn wasix_dynamic_linking_metadata_survives_instrumentation() {
        let mut wasm =
            wat::parse_str("(module (memory (export \"memory\") 1) (func (export \"_start\")))")
                .unwrap();
        let dylink = wasm_encoder::CustomSection {
            name: Cow::Borrowed("dylink.0"),
            data: Cow::Borrowed(&[1, 0]),
        };
        wasm.push(dylink.id());
        dylink.encode(&mut wasm);

        let metered = instrument_wasm(&wasm, 1_000_000).unwrap();
        let found = Parser::new(0)
            .parse_all(&metered.wasm)
            .filter_map(Result::ok)
            .any(|payload| {
                matches!(payload, Payload::CustomSection(section) if section.name() == "dylink.0")
            });
        assert!(found);
    }

    #[test]
    fn weights_match_wark_v03_cost_classes_and_penalty() {
        assert_eq!(weighted_opcode_cost("LocalGet"), Some(0));
        assert_eq!(weighted_opcode_cost("I32Add"), Some(1));
        assert_eq!(weighted_opcode_cost("I32Mul"), Some(2));
        assert_eq!(weighted_opcode_cost("I32DivS"), Some(3));
        assert_eq!(weighted_opcode_cost("MemoryCopy"), Some(6));
        assert_eq!(weighted_opcode_cost("I32AtomicLoad"), Some(11));
        assert_eq!(weighted_opcode_cost("I32AtomicStore"), Some(12));
        assert_eq!(weighted_opcode_cost("Throw"), Some(100));
        assert_eq!(weighted_opcode_cost("I32AtomicRmwCmpxchg"), Some(1000));
        assert_eq!(weighted_opcode_cost("MemoryAtomicWait32"), Some(1000));
        assert_eq!(weighted_opcode_cost("FutureInstruction"), Some(1000));
        assert_eq!(weighted_opcode_cost("AtomicFence"), Some(1000));
    }

    #[test]
    fn functions_with_a_loop_and_no_params_or_locals_get_one_unused_local() {
        let wasm = wat::parse_str(
            r#"(module
              (memory (export "memory") 1)
              (func (export "_start") (loop (br 0)))
              (func (local i64) (loop (br 0)))
              (func (param i32) (loop (br 0)))
              (func nop)
              (func (block (loop (br 1)))))"#,
        )
        .unwrap();
        let metered = instrument_wasm(&wasm, 1_000_000).unwrap();
        let locals = Parser::new(0)
            .parse_all(&metered.wasm)
            .filter_map(Result::ok)
            .filter_map(|payload| match payload {
                Payload::CodeSectionEntry(body) => Some(
                    body.get_locals_reader()
                        .unwrap()
                        .into_iter()
                        .map(|local| local.unwrap())
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .collect::<Vec<_>>();
        let i32_local = vec![(1, ValType::I32)];
        assert_eq!(
            locals,
            [
                i32_local.clone(),
                vec![(1, ValType::I64)],
                vec![],
                vec![],
                i32_local,
                vec![],
                vec![(1, ValType::I64)],
            ]
        );
    }

    #[test]
    fn reports_wark_compatible_static_operation_counts() {
        let wasm = wat::parse_str(
            "(module (memory (export \"memory\") 1) (func (export \"_start\") i32.const 1 i32.const 2 i32.add drop))",
        )
        .unwrap();
        let metered = instrument_wasm(&wasm, 1_000_000).unwrap();
        assert_eq!(metered.operations.get("I32Const"), Some(&2));
        assert_eq!(metered.operations.get("I32Add"), Some(&1));
        assert_eq!(metered.operations.get("Drop"), Some(&1));
    }

    fn looping(iterations: u32) -> Vec<u8> {
        wat::parse_str(format!(
            r#"(module
              (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                (local $remaining i32)
                i32.const {iterations} local.set $remaining
                (loop $again
                  local.get $remaining i32.const 1 i32.sub local.tee $remaining
                  br_if $again)))"#
        ))
        .unwrap()
    }

    fn run(wasm: &[u8], instruction_budget: u64) -> crate::RunResult {
        crate::run(RunRequest {
            wasm: wasm.to_vec(),
            args: Vec::new(),
            env: BTreeMap::new(),
            stdin: Vec::new(),
            files: BTreeMap::new(),
            output_paths: Vec::new(),
            cwd: Some("/".to_string()),
            startup_entropy_bytes: 0,
            determinism: DeterminismConfig {
                random_seed: 7,
                realtime_epoch_ms: 946_684_800_000,
                clock_step_ns: 1_000_000,
            },
            resources: ResourcePolicy {
                instruction_budget,
                logical_time_limit_ms: 60_000,
                memory_limit_bytes: 64 * 1024 * 1024,
                output_limit_bytes: 1024,
                filesystem_write_limit_bytes: 64 * 1024 * 1024,
                filesystem_entry_limit: 4_096,
            },
        })
        .unwrap()
    }

    #[test]
    fn costs_and_exhaustion_do_not_depend_on_safepoint_intervals() {
        let wasm = looping(3_000_000);
        let generous = run(&wasm, 10_000_000_000);
        assert_eq!(generous.termination, ExecutionTermination::Exited);
        let cost = generous.metrics.cost;
        assert!(cost > 5 * SAFEPOINT_INTERVAL as u64);
        assert_eq!(run(&wasm, cost * 7).metrics.cost, cost);

        let exact = run(&wasm, cost);
        assert_eq!(exact.termination, ExecutionTermination::Exited);
        assert_eq!(exact.metrics.cost, cost);

        let short = run(&wasm, cost - 1);
        assert_eq!(short.termination, ExecutionTermination::InstructionLimit);
        assert_eq!(short.metrics.cost, cost - 1);

        let within_one_interval = looping(1_000);
        let small = run(&within_one_interval, 1_000_000).metrics.cost;
        assert_eq!(run(&within_one_interval, small).metrics.cost, small);
        assert_eq!(
            run(&within_one_interval, small - 1).termination,
            ExecutionTermination::InstructionLimit
        );
    }

    #[test]
    fn the_meter_calls_the_safepoint_once_per_interval() {
        let recursing = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
              (memory (export "memory") 1)
              (func $fib (param $n i32) (result i32)
                local.get $n i32.const 2 i32.lt_u
                if (result i32) local.get $n
                else
                  local.get $n i32.const 1 i32.sub call $fib
                  local.get $n i32.const 2 i32.sub call $fib
                  i32.add
                end)
              (func (export "_start") i32.const 25 call $fib drop))"#,
        )
        .unwrap();
        for wasm in [looping(3_000_000), recursing] {
            let (calls, cost) = count_safepoints(&wasm);
            assert!(cost > 5 * SAFEPOINT_INTERVAL as u64);
            assert!(calls.abs_diff(cost / SAFEPOINT_INTERVAL as u64) <= 1);
        }
    }

    #[test]
    fn safepoint_loops_keep_their_branches_and_results() {
        use wasmer::{Function, Imports, Instance, Module, Store, Value};

        let wasm = wat::parse_str(
            r#"(module
              (memory (export "memory") 1)
              (func (export "compute") (result i32)
                (local $i i32) (local $j i32) (local $acc i32)
                (block $done
                  (loop $outer
                    (local.set $j (i32.const 0))
                    (block $inner_done
                      (loop $inner
                        (local.set $acc
                          (i32.add (local.get $acc) (i32.mul (local.get $i) (local.get $j))))
                        (local.set $j (i32.add (local.get $j) (i32.const 1)))
                        (br_if $done (i32.eq (local.get $acc) (i32.const -1)))
                        (br_table $inner $inner_done $done
                          (i32.gt_u (local.get $j) (i32.const 500)))))
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $outer (i32.lt_u (local.get $i) (i32.const 3000)))))
                (local.get $acc)
                (block $value (result i32)
                  (loop $early (result i32) (br $value (i32.const 3))))
                (i32.add)
                (loop $fallthrough (result i32) (i32.const 7))
                (i32.add)
                (i32.const 5)
                (loop $param (param i32) (result i32)
                  i32.const 1
                  i32.sub
                  local.tee $j
                  local.get $j
                  br_if $param)
                (i32.add)))"#,
        )
        .unwrap();
        let mut results = Vec::new();
        for module in [
            wasm.clone(),
            instrument_wasm(&wasm, 10_000_000_000).unwrap().wasm,
        ] {
            let mut store = Store::default();
            let module = Module::new(&store, &module).unwrap();
            let mut imports = Imports::new();
            imports.define(
                "wasm_oj_metering",
                "safepoint",
                Function::new_typed(&mut store, || {}),
            );
            let instance = Instance::new(&mut store, &module, &imports).unwrap();
            let compute = instance.exports.get_function("compute").unwrap();
            results.push(compute.call(&mut store, &[]).unwrap().to_vec());
            if let Ok(state) = super::meter_state(&instance) {
                let super::CostPoints::Remaining(remaining) =
                    super::remaining_points(&mut store, &state).unwrap()
                else {
                    panic!("meter exhausted");
                };
                assert!(10_000_000_000 - remaining > 5 * SAFEPOINT_INTERVAL as u64);
            }
        }
        assert_eq!(results[0], results[1]);
        assert!(matches!(results[0][..], [Value::I32(_)]));
    }

    fn count_safepoints(wasm: &[u8]) -> (u64, u64) {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};
        use wasmer::{Function, FunctionEnv, FunctionEnvMut, Imports, Instance, Module, Store};

        let budget = 10_000_000_000;
        let metered = instrument_wasm(wasm, budget).unwrap();
        let mut store = Store::default();
        let module = Module::new(&store, &metered.wasm).unwrap();
        let calls = Arc::new(AtomicU64::new(0));
        let env = FunctionEnv::new(&mut store, calls.clone());
        let mut imports = Imports::new();
        imports.define(
            "wasm_oj_metering",
            "safepoint",
            Function::new_typed_with_env(
                &mut store,
                &env,
                |env: FunctionEnvMut<Arc<AtomicU64>>| {
                    env.data().fetch_add(1, Ordering::Relaxed);
                },
            ),
        );
        imports.define(
            "wasi_snapshot_preview1",
            "proc_exit",
            Function::new_typed(&mut store, |_: i32| {}),
        );
        let instance = Instance::new(&mut store, &module, &imports).unwrap();
        instance
            .exports
            .get_function("_start")
            .unwrap()
            .call(&mut store, &[])
            .unwrap();
        let state = super::meter_state(&instance).unwrap();
        let super::CostPoints::Remaining(remaining) =
            super::remaining_points(&mut store, &state).unwrap()
        else {
            panic!("meter exhausted");
        };
        (calls.load(Ordering::Relaxed), budget - remaining)
    }

    #[test]
    fn modules_without_imports_receive_the_safepoint_import() {
        let wasm =
            wat::parse_str("(module (memory (export \"memory\") 1) (func (export \"_start\")))")
                .unwrap();
        let metered = instrument_wasm(&wasm, 1_000_000).unwrap();
        let imports = Parser::new(0)
            .parse_all(&metered.wasm)
            .filter_map(Result::ok)
            .filter_map(|payload| match payload {
                Payload::ImportSection(section) => Some(
                    section
                        .into_imports()
                        .map(|import| {
                            let import = import.unwrap();
                            format!("{}.{}", import.module, import.name)
                        })
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(imports, [vec!["wasm_oj_metering.safepoint".to_string()]]);
        wasmparser::Validator::new()
            .validate_all(&metered.wasm)
            .unwrap();
    }
}
