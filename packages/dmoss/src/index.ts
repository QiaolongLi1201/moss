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
  MOSS_HOST_TOOL_RESULT_SURFACES,
  MOSS_HOST_TOOL_SURFACE_KINDS,
  evaluateMossHostCompatibility,
} from './contracts/host-adapter.js';
export type {
  MossHostAdapterContractVersion,
  MossHostCapabilityKind,
  MossHostCapabilityRef,
  MossHostCapabilityStability,
  MossHostCompatibilityReport,
  MossHostCompatibilityRequirement,
  MossHostCompatibilityStatus,
  MossHostEventSinkRef,
  MossHostKnowledgeRef,
  MossHostPackageRef,
  MossHostProviderRef,
  MossHostRuntimeManifest,
  MossHostToolResultSurface,
  MossHostToolRef,
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
  MossAsyncTaskRegistry,
  MossAsyncTaskResult,
  MossAsyncTaskRunner,
  MossAsyncTaskSnapshot,
  MossAsyncTaskStartRequest,
  MossAsyncTaskStatus,
  MossAsyncTaskStopReason,
} from './contracts/async-task.js';

// --- Constants ---
export { DEFAULT_MODEL } from './constants.js';

// --- Robotics engineering prompts ---
export {
  buildRoboticsEngineeringPrompt,
  buildRoboticsEngineeringPromptQuick,
} from './prompts/robotics-engineering-prompt.js';
