/**
 * Robot Hub — user-defined robotics knowledge module types and converters.
 *
 * Provides serializable types for persisting KnowledgeModules to JSON,
 * plus a converter from the serialized form back to the runtime interface.
 *
 * Host applications use these types to build module stores (filesystem, DB, etc.).
 */

import type {
  KnowledgeModule,
  DeviceProfileBase,
  DocIndexEntry,
  PromptFragment,
} from '@rdk-moss/core';

export interface RobotHubModuleMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  author?: string;
  tags: string[];
  enabled: boolean;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
  sourceFiles?: string[];
  platforms: string[];
}

export interface SerializableCommandPattern {
  pattern: string;
  category: string;
  description: string;
  riskLevel: 'safe' | 'moderate' | 'dangerous';
}

export interface SerializableFailureHint {
  errorPattern: string;
  suggestion: string;
  docUrl?: string;
}

export interface RobotHubModuleData {
  deviceProfiles: Record<string, DeviceProfileBase>;
  docIndex: DocIndexEntry[];
  promptFragments: PromptFragment[];
  commandPatterns: SerializableCommandPattern[];
  failureHints: SerializableFailureHint[];
  ecosystemPrompt: string;
}

export interface RobotHubModule {
  meta: RobotHubModuleMeta;
  data: RobotHubModuleData;
}

/** Convert a serialized RobotHubModule to a runtime KnowledgeModule. */
export function toKnowledgeModule(hub: RobotHubModule): KnowledgeModule {
  return {
    id: hub.meta.id,
    name: hub.meta.name,
    version: hub.meta.version,
    description: hub.meta.description,
    platforms: hub.meta.platforms,
    platformClaimPriority: 100,
    getDeviceProfiles: () => hub.data.deviceProfiles,
    getDocIndex: () => hub.data.docIndex,
    getPromptFragments: () => hub.data.promptFragments,
    getCommandPatterns: () =>
      hub.data.commandPatterns.map((p) => ({
        ...p,
        pattern: new RegExp(p.pattern, 'i'),
      })),
    getFailureHints: () =>
      hub.data.failureHints.map((h) => ({
        ...h,
        errorPattern: new RegExp(h.errorPattern, 'i'),
      })),
    getEcosystemPrompt: () => hub.data.ecosystemPrompt,
  };
}

/** Create an empty module scaffold with default metadata. */
export function createEmptyModule(name: string, description: string): RobotHubModule {
  const id = `user-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
  const now = new Date().toISOString();
  return {
    meta: {
      id,
      name,
      version: '1.0.0',
      description,
      tags: [],
      enabled: true,
      builtin: false,
      createdAt: now,
      updatedAt: now,
      platforms: [],
    },
    data: {
      deviceProfiles: {},
      docIndex: [],
      promptFragments: [],
      commandPatterns: [],
      failureHints: [],
      ecosystemPrompt: '',
    },
  };
}
