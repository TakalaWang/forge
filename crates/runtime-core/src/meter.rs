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
use wasmer::{AsStoreMut, Global, Instance};

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

struct MeterInitializer {
    budget: i64,
}

impl Reencode for MeterInitializer {
    type Error = MeterInitializationError;

    fn parse_global_section(
        &mut self,
        globals: &mut wasm_encoder::GlobalSection,
        section: wasmparser::GlobalSectionReader<'_>,
    ) -> Result<(), ReencodeError<Self::Error>> {
        let meter_ordinal = section.count().checked_sub(1).ok_or_else(|| {
            ReencodeError::UserError(MeterInitializationError(
                "instrumented module has no meter global".to_string(),
            ))
        })?;
        for (ordinal, global) in section.into_iter().enumerate() {
            let global = global?;
            if u32::try_from(ordinal).ok() == Some(meter_ordinal) {
                if global.ty.content_type != wasmparser::ValType::I64 || !global.ty.mutable {
                    return Err(ReencodeError::UserError(MeterInitializationError(
                        "instrumented meter global has an unexpected type".to_string(),
                    )));
                }
                globals.global(
                    self.global_type(global.ty)?,
                    &wasm_encoder::ConstExpr::i64_const(self.budget),
                );
            } else {
                wasm_encoder::reencode::utils::parse_global(self, globals, global)?;
            }
        }
        Ok(())
    }
}

fn set_initial_meter_budget(wasm: &[u8], budget: i64) -> Result<Vec<u8>, String> {
    validate_meter_global_position(wasm)?;
    let mut module = wasm_encoder::Module::new();
    MeterInitializer { budget }
        .parse_core_module(&mut module, wasmparser::Parser::new(0), wasm)
        .map_err(|error| format!("failed to initialize weighted meter: {error}"))?;
    Ok(module.finish())
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
    use super::{METER_MODEL, instrument_wasm, weighted_opcode_cost};
    use std::borrow::Cow;
    use wasm_encoder::{Encode, Section};
    use wasmparser::{ExternalKind, Parser, Payload};

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
}
