/**
 * @rdk-moss/core — vendor-neutral contracts and robotics prompts for the D-Moss Agent framework.
 *
 * This package is the open-source kernel of D-Moss. It contains:
 *  - KnowledgeModule: pluggable domain knowledge for any hardware platform
 *  - VendorPlugin / PromptContributor / ToolContributor: extension points
 *  - PlatformExtension: the primary integration point for new device ecosystems
 *  - Robotics engineering prompts (board/vendor-agnostic)
 *
 * This package has ZERO host dependencies — it can be published and consumed standalone.
 */

// --- Knowledge Module contracts ---
export type {
  KnowledgeModule,
  DeviceProfileBase,
  CameraInterface,
  GpioSpec,
  DocIndexEntry,
  PromptFragment,
  CommandPattern,
  FailureHint,
  EndorsedSkillRef,
} from './contracts/knowledge-module.js';

// --- Vendor Plugin contracts ---
export type {
  DmossPromptContributor,
  DmossToolContributor,
  DmossVendorPlugin,
} from './contracts/vendor-plugin.js';

// --- Platform Extension contracts ---
export type {
  DmossPlatformExtensionIdentities,
  DmossPlatformExtension,
} from './contracts/platform-extension.js';

// --- Device Family taxonomy ---
export type { DeviceFamily } from './contracts/device-family.js';

// --- Host Adapter contract ---
export {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  MOSS_HOST_CAPABILITY_COVERAGE_PRIORITIES,
  MOSS_HOST_CAPABILITY_COVERAGE_STATUSES,
  MOSS_HOST_CAPABILITY_COVERAGE_STATUS_DEFINITIONS,
  MOSS_HOST_CHANNEL_BACKPLANE_CAPABILITIES,
  MOSS_HOST_EFFECTIVE_TOOL_NOTICE_CODES,
  MOSS_HOST_TASK_SURFACE_CAPABILITIES,
  MOSS_HOST_TOOL_RESULT_SURFACES,
  MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES,
  MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS,
  MOSS_HOST_TOOL_SURFACE_KINDS,
  buildMossHostEffectiveToolInventory,
  evaluateMossHostCompatibility,
  projectMossHostRuntimeCapabilities,
} from './contracts/host-adapter.js';
export type {
  MossHostAdapterContractVersion,
  MossHostCapabilityCoveragePriority,
  MossHostCapabilityCoverageRef,
  MossHostCapabilityCoverageStatus,
  MossHostCapabilityKind,
  MossHostCapabilityRef,
  MossHostCapabilityStability,
  MossHostCompatibilityReport,
  MossHostCompatibilityRequirement,
  MossHostCompatibilityStatus,
  MossHostEffectiveToolInventory,
  MossHostEffectiveToolInventoryContext,
  MossHostEffectiveToolNotice,
  MossHostEffectiveToolNoticeCode,
  MossHostEffectiveToolNoticeSeverity,
  MossHostEffectiveToolRef,
  MossHostEffectiveToolSurfaceRef,
  MossHostEventSinkRef,
  MossHostKnowledgeRef,
  MossHostChannelBackplaneCapability,
  MossHostPackageRef,
  MossHostProviderRef,
  MossHostRuntimeManifest,
  MossHostRuntimeCapabilityProjection,
  MossHostTaskSurfaceCapability,
  MossHostToolResultSurface,
  MossHostToolRef,
  MossHostToolSurfaceProgressMode,
  MossHostToolSurfaceReadinessSignal,
  MossHostToolSurfaceRef,
  MossHostToolSurfaceKind,
} from './contracts/host-adapter.js';

// --- Async task/subagent lifecycle contract ---
export {
  InMemoryMossAsyncTaskRegistry,
  createInMemoryMossAsyncTaskRegistry,
} from './contracts/async-task.js';
export type {
  InMemoryMossAsyncTaskRegistryOptions,
  MossAsyncTaskCompletion,
  MossAsyncTaskHandle,
  MossAsyncTaskKind,
  MossAsyncTaskProgress,
  MossAsyncTaskRegistry,
  MossAsyncTaskResult,
  MossAsyncTaskRunner,
  MossAsyncTaskSnapshot,
  MossAsyncTaskStartRequest,
  MossAsyncTaskStatus,
  MossAsyncTaskStopReason,
  MossAsyncTaskUpdate,
} from './contracts/async-task.js';

// --- Constants ---
export { DEFAULT_MODEL } from './constants.js';

// --- Robotics engineering prompts ---
export {
  buildRoboticsEngineeringPrompt,
  buildRoboticsEngineeringPromptQuick,
} from './prompts/robotics-engineering-prompt.js';

// --- Software engineering prompts (通用编码底座，与 robotics 平行可切换) ---
export {
  buildSoftwareEngineeringPrompt,
  buildSoftwareEngineeringPromptQuick,
} from './prompts/software-engineering-prompt.js';

// --- Agent behavior (communication style / code-change discipline / faithful reporting / careful execution; domain-independent) ---
export {
  buildAgentBehaviorPrompt,
  buildAgentBehaviorPromptQuick,
} from './prompts/agent-behavior-prompt.js';

// --- Response-language policy (English-first, auto-switch to the user's language; domain-independent) ---
export {
  buildLanguagePolicyPrompt,
  buildLanguagePolicyPromptQuick,
} from './prompts/language-policy-prompt.js';
