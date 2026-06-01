export {
  KnowledgeRegistry,
  bridgeGlobalKnowledgeModuleForExtension,
  registerKnowledgeModule,
  unbridgeGlobalKnowledgeModuleForExtension,
  unregisterKnowledgeModule,
  getKnowledgeModule,
  getAllKnowledgeModules,
  findModuleForPlatform,
  findModuleForFamily,
  getAllDeviceProfiles,
  getAllDocEntries,
  getAllPromptFragments,
  getAllCommandPatterns,
  getAllFailureHints,
  getAggregatedEcosystemPrompt,
} from './registry.js';

export type {
  KnowledgeModule,
  DeviceProfileBase,
  DocIndexEntry,
  PromptFragment,
  CommandPattern,
  FailureHint,
} from '@rdk-moss/core';
export type { DeviceFamily } from '@rdk-moss/core';

// Robot Hub (user-defined knowledge modules)
export {
  toKnowledgeModule,
  createEmptyModule,
} from './robot-hub-types.js';
export type {
  RobotHubModule,
  RobotHubModuleMeta,
  RobotHubModuleData,
  SerializableCommandPattern,
  SerializableFailureHint,
} from './robot-hub-types.js';
