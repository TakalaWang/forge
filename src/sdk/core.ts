export { DEFAULT_DETERMINISM, resolveDeterminism } from "../core/determinism";
export { canonicalJsonBytes, parseCanonicalJsonBytes } from "../core/canonical-json";
export type { CanonicalJsonValue } from "../core/canonical-json";
export {
  asWasmOjError,
  WasmOjError,
  WASM_OJ_ERROR_CODES,
  WASM_OJ_ERROR_STAGES,
} from "../core/errors";
export type {
  WasmOjErrorCode,
  WasmOjErrorOptions,
  WasmOjErrorRecord,
  WasmOjErrorStage,
} from "../core/errors";
export {
  WASM_OJ_CONTRACT_ID,
  WASM_OJ_CONTRACT_VERSION,
  WASM_OJ_SCHEMAS,
  WASM_OJ_STORAGE,
} from "../core/contract";
export { DEFAULT_RESOURCE_POLICY, resolveResourcePolicy, WEIGHTED_METER_MODEL } from "../core/resources";
export {
  CostBaselineRegistry,
  createDefaultCostBaselineRegistry,
  createExtendedCostBaselineRegistry,
  normalizeExecutionMetrics,
  resolveArtifactCostBudget,
  resolveCostBudget,
  unavailableExecutionMetrics,
} from "../core/cost";
export type { CostBudget, RawExecutionMetrics } from "../core/cost";
export { costProfileId, isCostProfileFor } from "../core/cost-profile";
export {
  runtimeIdentityBytes,
  WASM_OJ_RUNTIME_COMPONENTS,
  WASM_OJ_RUNTIME_IDENTITY_SHA256,
  verifyRuntimeIdentity,
} from "../core/runtime-identity";
export { assertLanguageIdentifier, isBuiltinLanguage, LANGUAGES } from "../core/types";
export { assertValidProject } from "../core/project-validation";
export { PROJECT_SOURCE_LIMITS } from "../core/project-files";
export {
  assertValidBuildArtifact,
  createRuntimeBundleManifest,
} from "../core/artifact-validation";
export type { ArtifactBuildExpectation } from "../core/artifact-validation";
export type {
  ArtifactMetadata,
  BuiltinLanguage,
  BuildConfig,
  BuildArtifact,
  BuildResult,
  BrowserRuntimeDriverPlugin,
  CompilerRequest,
  CompilerResponse,
  CompilerTraceEvent,
  DeterminismConfig,
  Diagnostic,
  DiagnosticSeverity,
  Language,
  OptimizationLevel,
  Project,
  ProjectConfig,
  ProjectFile,
  ResourcePolicy,
  ExecutionMetrics,
  ExecutionTermination,
  InteractiveProcessResult,
  InteractiveProgramConfig,
  InteractiveRunConfig,
  InteractiveRunResult,
  RunConfig,
  RunResult,
  RunnerRequest,
  RunnerResponse,
  RuntimeBundleArtifact,
  TargetAbi,
  WasmArtifact,
  WorkerProgress,
  BrowserToolchainSource,
  ServerToolchainSource,
  ToolchainAssetDescriptor,
  ToolchainDescriptor,
  ToolchainProfile,
} from "../core/types";
export {
  browserToolchainAssetBaseUrl,
  browserToolchainAssetUrl,
  snapshotBrowserToolchainSources,
  toolchainAssetSource,
  toolchainProfileSource,
  validateBrowserToolchainSources,
  validateServerToolchainSources,
  validateToolchainDescriptors,
} from "../core/toolchain-sources";
export { assertCompilerCacheKey } from "../core/hash";
export { browserToolchainAssetPaths, toolchainCacheIdentity } from "../core/toolchains";
export type { BrowserToolchainAssetSelection } from "../core/toolchains";
export { createEngine, Engine } from "./engine";
export type { JudgeProjectResult, EngineOptions } from "./engine";
export type {
  Operation,
  OperationEvent,
  OperationEventPayload,
  OperationKind,
  OperationState,
  SubmissionOperation,
  SubmissionRequest,
} from "../operations/operation";
export type { ArtifactStore, PrecompileOutcome, PrecompileStatus } from "../compiler/coordinator";
export type { Compiler } from "../compiler/compiler";
export {
  decodeLibcxxPchManifest,
  WASM_OJ_LIBCXX_PCH_HEADER,
  isToolchainLibcxxPchHeader,
} from "../compiler/libcxx-pch";
export type {
  LibcxxPchAsset,
  LibcxxPchManifest,
  LibcxxPchProfile,
} from "../compiler/libcxx-pch";
export { CompilerRegistry } from "../compiler/compiler-registry";
export type { CompilerRegistration } from "../compiler/compiler-registry";
export type { Runner } from "../runner/runner";
export {
  createDefaultRuntimeDrivers,
  prepareArtifactInteraction,
  prepareArtifactRun,
  prepareTrustedJudgeRun,
  RuntimeDriverRegistry,
} from "../runner/artifact";
export type {
  PackageFileSystemRequest,
  PreparedRunRequest,
  RuntimeDriver,
  RuntimeResolver,
} from "../runner/artifact";
export type {
  CompileOptions,
  ExecuteResult,
  InteractiveExecuteResult,
  InteractiveOptions,
  InteractiveProgramOptions,
  RunOptions,
} from "./types";
export { createSdkProject } from "./project";
export type { CompileInput } from "./project";
export { JudgeEngine, createJudgeExecutor } from "../judge/engine";
export type {
  JudgeCaseResult,
  JudgeCaseVerdict,
  JudgeEngineOptions,
  JudgeExecutionAdapter,
  JudgeExecutor,
  JudgeInputProvider,
  JudgeMatchResult,
  JudgeMatcher,
  JudgeMatcherContext,
  JudgeResult,
  JudgeRunOptions,
  JudgeResolvedInput,
} from "../judge/engine";
export {
  fileMatcher,
  floatMatcher,
  sha256Matcher,
  setMatcher,
  textMatcher,
  tokenMatcher,
  validateJudgeSpec,
  wasmCheckerMatcher,
  assertJudgeGuestFilePath,
} from "../judge/spec";
export type {
  JudgeCaseSpec,
  BatchJudgeCaseSpec,
  InteractiveJudgeCaseSpec,
  JudgeFileInputSpec,
  JudgeInputSpec,
  JudgeMatcherSpec,
  JudgeProgramSpec,
  JudgeSpec,
} from "../judge/spec";
export { normalizeOutput } from "../judge/normalization";
export type { OutputNormalization } from "../judge/normalization";
export {
  BROWSER_COLLECTION_SCHEMA,
  BROWSER_PROBLEM_SCHEMA,
  PROBLEM_STARTER_LIMITS,
  parseProblemBundle,
  parseProblemCollectionIndex,
  parseStandaloneProblemBundle,
  problemCollectionRevision,
  verifyProblemBundleBytes,
  verifyProblemCollectionRevision,
} from "../judge/problem-catalog-loader";
export {
  assertJudgeDataCostProfile,
  assertProblemCostProfile,
  scoreJudgeDataResults,
  scoreProblemResults,
  summarizeProblemPolicies,
} from "../judge/problem-scoring";
export {
  CONTEST_PUBLIC_PROJECTION_SCHEMA,
  contestPublicProjectionBytes,
  createContestPublicProjection,
  deriveContestPublic,
  derivePracticePublic,
} from "../online-judge/contest-public";
export type { ContestPublicProjection } from "../online-judge/contest-public";
export { parseJudgeAllowedProfiles } from "../online-judge/compile-profiles";
export type { JudgeAllowedProfile, JudgeAllowedProfiles } from "../online-judge/compile-profiles";
export {
  assertJudgeDataMatchesPracticePublic,
  deriveJudgeData,
  WASM_OJ_JUDGE_DATA_SCHEMA,
  parseJudgeData,
} from "../online-judge/judge-data";
export type { JudgeDataCase, JudgeData, JudgePolicy } from "../online-judge/judge-data";
export {
  decodeJudgePackageForExecution,
  encodeJudgePackage,
  WASM_OJ_JUDGE_PACKAGE_MAGIC,
  WASM_OJ_JUDGE_PACKAGE_MAX_BYTES,
  WASM_OJ_JUDGE_PACKAGE_SCHEMA,
  judgePackageSemanticDigest,
  parseJudgePackageManifest,
  readJudgePackageManifest,
  validateJudgePackage,
} from "../online-judge/judge-package";
export type {
  EncodedJudgePackage,
  DecodedJudgePackageForExecution,
  JudgePackageInput,
  JudgePackageManifest,
  JudgePackageAllowedProfile,
  JudgePackageAssetInput,
  JudgePackageAssetReference,
  JudgePackageBlobReference,
  JudgePackageByteSource,
  JudgePackageInputJudge,
  JudgePackageManifestJudge,
  TrustedJudgeAsset,
  TrustedJudgeExecutable,
  ValidateJudgePackageOptions,
  ValidatedJudgePackage,
} from "../online-judge/judge-package";
export {
  REPOSITORY_AUTHORING_JUDGES_SCHEMA,
  parseRepositoryAuthoringJudges,
} from "../online-judge/repository-authoring";
export type {
  RepositoryAuthoringJudges,
  RepositoryAuthoringJudgeProblem,
  RepositorySourceArtifact,
  RepositorySourceAsset,
  RepositorySourceJudge,
  RepositorySourceObject,
} from "../online-judge/repository-authoring";
export {
  TRUSTED_JUDGE_RUNTIME_PROFILES,
  TRUSTED_JUDGE_WASIP1_IMPORTS,
  TRUSTED_JUDGE_WASM_MAX_BYTES,
  validateTrustedJudgeWasm,
} from "../online-judge/trusted-judge-wasm";
export type {
  TrustedJudgeRuntimeProfile,
  TrustedJudgeProgram,
  TrustedJudgeWasmInfo,
  TrustedJudgeWasmValidationOptions,
} from "../online-judge/trusted-judge-wasm";
export { trustedJudgeSpec } from "../online-judge/trusted-judge";
export type {
  PolicyPerformanceAggregate,
  ProblemScore,
  ScoredProblemCase,
  SubmissionPolicySummary,
} from "../judge/problem-scoring";
export type {
  ProblemBundleDescriptor,
  ProblemCollectionEntry,
  ProblemCollectionIndex,
} from "../judge/problem-catalog-loader";
export type {
  JudgeProblem,
  JudgeStarterTemplate,
  JudgeStarterTemplates,
} from "../judge/problem-model";
export {
  assertValidDependencyBuildBundle,
  createDefaultDependencyBuildAdapters,
  createDependencyBuildBundle,
  DEPENDENCY_BUILD_LIMITS,
  dependencyFileTreeSha256,
  verifyDependencyBuildBundle,
} from "../dependencies/build";
export type {
  DependencyBuildAdapter,
  DependencyBuildBundle,
  MaterializedDependencyPackage,
} from "../dependencies/build";
export {
  createDefaultDependencyManager,
  DependencyManager,
  MemoryDependencyCache,
} from "../dependencies/manager";
export {
  CargoLockDependencyResolver,
  CppLockDependencyResolver,
  createDefaultDependencyResolvers,
  DependencyNetworkError,
  GoLockDependencyResolver,
  goModuleZipHash,
  NpmLockDependencyResolver,
  PyPiLockDependencyResolver,
} from "../dependencies/resolvers";
export {
  BrowserDependencyNetworkConsent,
  normalizeDependencyNetworkAccess,
  normalizeDependencyNetworkScope,
} from "../dependencies/network-consent";
export type {
  DependencyConsentStorage,
  DependencyNetworkConsentPrompt,
} from "../dependencies/network-consent";
export type {
  CppDependencyLockSource,
  DependencyFetch,
  DependencyResolverOptions,
} from "../dependencies/resolvers";
export {
  assertValidDependencyLock,
  createDependencyLock,
  dependencyLockSha256,
  dependencyManifestSha256,
} from "../dependencies/lock";
export type {
  DependencyEcosystem,
  DependencyLock,
  DependencyManifest,
  DependencyNetworkAccess,
  DependencyNetworkAuthorizer,
  DependencyNetworkScope,
  DependencyOfflineBundle,
  DependencyRequirement,
  DependencyResolutionContext,
  DependencySourceFile,
  DependencyCache,
  DependencyResolver,
  LockedDependencyPackage,
  ResolveDependencyOptions,
  ResolvedDependencyGraph,
} from "../dependencies/types";
export {
  assertValidReplayBundle,
  createReplayBundle,
  decodeReplayBundle,
  encodeReplayBundle,
  replayBundleSha256,
  judgeTranscript,
  replayBundle,
} from "../replay/bundle";
export type {
  ReplayBundle,
  ReplayBundleInput,
  ReplayDecodeOptions,
  ReplayHost,
  ReplayJudgeCaseTranscript,
  ReplayJudgeOperation,
  ReplayJudgeTranscript,
  ReplayOperation,
  ReplayOptions,
  ReplayResult,
  ReplayRunOperation,
} from "../replay/bundle";
export {
  compareConformanceSnapshots,
  deterministicTranscript,
  runConformanceHost,
  runConformanceMatrix,
} from "../conformance/matrix";
export type {
  ConformanceCase,
  ConformanceHost,
  ConformanceMismatch,
  ConformanceOptions,
  ConformanceReport,
  ConformanceRunExpectation,
  ConformanceSample,
  ConformanceSnapshot,
  DeterministicTranscript,
} from "../conformance/matrix";
export {
  CPP_STDLIB_CONFORMANCE_CASE,
  DEFAULT_CONFORMANCE_CASES,
  FULL_CONFORMANCE_CASES,
} from "../conformance/cases";
