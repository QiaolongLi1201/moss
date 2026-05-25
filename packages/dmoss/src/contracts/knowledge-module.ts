/**
 * Knowledge Module — pluggable domain knowledge contract for D-Moss Agent.
 *
 * Each module provides domain-specific knowledge (device profiles, documentation,
 * prompt fragments, command semantics) that the Agent can use during orchestration.
 * The Agent core remains domain-agnostic; domain expertise is injected via modules.
 *
 * Third-party hardware vendors implement this interface to integrate their
 * device ecosystems into D-Moss (e.g. Jetson, Raspberry Pi, custom boards).
 */

import type { DeviceFamily } from './device-family.js';

/** Camera interface specification on a device board. */
export interface CameraInterface {
  /** Interface type (USB UVC, MIPI CSI, GMSL, or custom) */
  type: 'usb' | 'mipi' | 'gmsl' | 'other';
  /** Number of ports of this type */
  count: number;
  /** Additional notes (e.g. lane count, USB version) */
  notes?: string;
}

/** GPIO header specification on a device board. */
export interface GpioSpec {
  /** Total physical pin count (e.g. 40 for standard header) */
  pinCount: number;
  /** Number of configurable GPIO lines */
  gpioCount: number;
  /** Number of I2C bus interfaces */
  i2cBuses: number;
  /** Number of SPI bus interfaces */
  spiBuses: number;
  /** Number of UART ports */
  uartPorts: number;
  /** Number of PWM output channels */
  pwmChannels: number;
  /** Logic level voltage (e.g. '3.3V') */
  voltage: string;
  /** Additional notes (e.g. real-time MCU handling) */
  notes?: string;
}

/**
 * Base device profile — describes a hardware board's capabilities and
 * environment so the Agent can tailor commands, diagnostics, and model
 * deployment to the target device.
 *
 * Knowledge module implementors should extend or populate this for each
 * supported board variant.
 */
export interface DeviceProfileBase {
  /** Platform identifier used as lookup key (e.g. 'vendor-board-v1', 'jetson-orin-nano') */
  platform: string;
  /** Human-readable board name shown in UI and prompts */
  displayName: string;
  /** System-on-Chip model (e.g. 'SoC-A1', 'Orin Nano') */
  soc: string;
  /** Primary compute accelerator type (e.g. 'NPU', 'GPU', 'TPU') */
  computeUnit: string;
  /** Peak compute performance in TOPS */
  computeTops: number;
  /** CPU description (e.g. 'Cortex-A55 × 8 @ 1.8 GHz') */
  cpu: string;
  /** Total RAM in gigabytes */
  ramGb: number;
  /** Preferred model format for inference (e.g. 'onnx', 'trt', vendor-specific) */
  modelFormat: string;
  /** Shell command to query device health/utilization (e.g. 'vendor-smi', 'tegrastats') */
  diagnosticCommand: string;
  /** Root path where inference runtimes are installed (e.g. '/opt/sdk') */
  runtimeBasePath: string;
  /** Default Python interpreter path (e.g. '/usr/bin/python3') */
  systemPython: string;
  /** Inference library package name (e.g. 'vendor-dnn', 'tensorrt') */
  inferLibPackage: string;
  /** String patterns used to detect this device during SSH probing */
  detectionPatterns: string[];
  /** Known limitations the Agent should be aware of */
  limitations: string[];
  /** Base URL for official documentation */
  docBaseUrl: string;
  /** Free-text capability notes injected into prompts */
  capabilityNotes: string[];

  /* ---- optional structured hardware data (v1.1) ---- */

  /** Camera interfaces available on the board */
  cameraInterfaces?: CameraInterface[];
  /** 40-pin or other GPIO header specification */
  gpio?: GpioSpec;
  /** Network interfaces (e.g. ['eth0', 'wlan0', 'can0']) */
  networkInterfaces?: string[];
  /** Storage specification (e.g. 'eMMC 32GB + microSD') */
  storageSpec?: string;
  /** Power specification (e.g. '5V/3A USB-C') */
  powerSpec?: string;
  /** Supported OS versions or image names */
  supportedOs?: string[];
  /** Recommended use cases for this board */
  recommendedUseCases?: string[];
  /** Vendor-specific extension data (opaque to D-Moss core) */
  vendorExtensions?: Record<string, unknown>;
}

export interface KnowledgeSourceRef {
  type: string;
  url?: string;
  repo?: string;
  commit?: string;
  documentVersion?: string;
  retrievedAt?: string;
}

export interface KnowledgeCompatibilityScope {
  platforms?: string[];
  boards?: string[];
  socs?: string[];
  rdkVersions?: string[];
  osVersions?: string[];
  toolchains?: string[];
}

export interface KnowledgeChunkPolicy {
  strategy: 'none' | 'heading' | 'paragraph' | 'qa' | 'command' | 'release-note';
  maxTokens?: number;
  overlapTokens?: number;
}

export interface KnowledgeRecordMetadata {
  id: string;
  source?: KnowledgeSourceRef;
  scope?: KnowledgeCompatibilityScope;
  status?: string;
  confidence?: string;
  priority?: number;
  lastReviewedAt?: string;
  validFrom?: string;
  validTo?: string;
  supersedes?: string[];
  citationLabel?: string;
  chunkPolicy?: KnowledgeChunkPolicy;
}

/** An entry in the documentation index for search and prompt injection. */
export interface DocIndexEntry {
  /** Document title */
  title: string;
  /** Canonical URL to the document */
  url: string;
  /** Section/category grouping (e.g. 'Getting Started', 'API Reference') */
  section: string;
  /** Search tags for retrieval matching */
  tags: string[];
  /** Optional governance/provenance metadata from trusted knowledge packages. */
  metadata?: KnowledgeRecordMetadata;
}

/**
 * A prompt fragment injected into the system prompt by a knowledge module.
 *
 * Fragments are filtered by `tier` (model size) and `mode` (thinking depth),
 * then sorted by `priority` (higher = earlier in prompt).
 */
export interface PromptFragment {
  /** Unique identifier for this fragment */
  id: string;
  /** Prompt section — controls where in the system prompt this fragment appears:
   *  - `persona`: Agent identity and behavior
   *  - `reasoning`: How to think about problems
   *  - `tool_contract`: Tool usage rules and patterns
   *  - `search_trigger`: When to search documentation
   *  - `ecosystem`: Hardware/software ecosystem context
   *  - `collaboration`: Multi-agent and delegation rules
   */
  section: 'persona' | 'reasoning' | 'tool_contract' | 'search_trigger' | 'ecosystem' | 'collaboration';
  /** Model tier filter — `all` includes in every model size; `large`/`medium`/`small` only for that tier */
  tier: 'all' | 'large' | 'medium' | 'small';
  /** Mode filter — `all` for both quick and thinking modes; `quick`/`thinking` for that mode only */
  mode: 'all' | 'quick' | 'thinking';
  /** The actual prompt text to inject */
  content: string;
  /** Sort priority (higher values appear earlier in prompt assembly) */
  priority: number;
  /** Optional governance/provenance metadata from trusted knowledge packages. */
  metadata?: KnowledgeRecordMetadata;
}

/**
 * A pattern that categorizes shell commands by risk level.
 *
 * Note: `pattern` is a `RegExp` for runtime matching.  If you need to
 * serialize/deserialize patterns (e.g. for JSON config), convert via
 * `new RegExp(source, flags)`.
 */
export interface CommandPattern {
  /** Regular expression matching the command text */
  pattern: RegExp;
  /** Category label (e.g. 'filesystem', 'network', 'package-manager') */
  category: string;
  /** Human-readable description of what this pattern matches */
  description: string;
  /** Risk assessment: `safe` (read-only), `moderate` (reversible), `dangerous` (destructive) */
  riskLevel: 'safe' | 'moderate' | 'dangerous';
  /** Optional governance/provenance metadata from trusted knowledge packages. */
  metadata?: KnowledgeRecordMetadata;
}

/**
 * A failure hint that maps error patterns to recovery suggestions.
 *
 * When a tool execution fails, the Agent matches error output against
 * registered hints and includes suggestions in its recovery reasoning.
 *
 * Note: `errorPattern` is a `RegExp` — see `CommandPattern` for
 * serialization considerations.
 */
export interface FailureHint {
  /** Regular expression matching error output text */
  errorPattern: RegExp;
  /** Recovery suggestion shown to the Agent */
  suggestion: string;
  /** Optional documentation URL for further reference */
  docUrl?: string;
  /** Optional governance/provenance metadata from trusted knowledge packages. */
  metadata?: KnowledgeRecordMetadata;
}

/**
 * A skill endorsed by a knowledge module — the module declares
 * "this skill belongs to my domain / is authoritative for my platforms".
 *
 * The knowledge module does NOT bundle the SKILL.md file itself: the host
 * still discovers files via its own skill scanner (e.g. scanning
 * `<workspace>/skills/**`). The module only declares which skill IDs it
 * endorses, so skill-routing code (e.g. `find_skills`) can rank endorsed
 * skills higher when the corresponding platform is active.
 *
 * This keeps skills vendor-neutral (any host layout works) while letting
 * domain modules express ownership without moving or duplicating files.
 */
export interface EndorsedSkillRef {
  /**
   * Skill identifier — must match the SKILL.md folder name OR the
   * frontmatter `name` (case-insensitive). Registries resolve both.
   */
  id: string;
  /** Optional human-readable category (e.g. `hardware`, `ros-ecosystem`). */
  category?: string;
  /**
   * Optional platforms this skill is authoritative for. If omitted,
   * the endorsement applies whenever the owning module is active.
   */
  platforms?: string[];
  /**
   * Optional boost score (0-100). Higher values rank the skill earlier
   * in `rankByPreferredRefs`-style ordering. Defaults to `50` when
   * omitted. Explicit caller preferences (`preferredRefs`) always win
   * over endorsement scores.
   */
  priority?: number;
  /** Optional governance/provenance metadata from trusted knowledge packages. */
  metadata?: KnowledgeRecordMetadata;
}

export interface KnowledgeModule {
  id: string;
  name: string;
  version: string;
  description: string;

  /** All supported platform identifiers */
  platforms: string[];

  /**
   * When multiple modules claim the same `platform`, higher priority wins
   * in `findModuleForPlatform()`. Defaults to `0`.
   * Recommended: built-in modules use `0`, user-supplied or community modules use `100+`.
   */
  platformClaimPriority?: number;

  /**
   * Optional device family the module primarily serves.
   *
   * Enables fast family-based routing via
   * `knowledge-module-registry.findModuleForFamily(family)` — useful for
   * the auto-detect flow where the probe returns a `DeviceFamily` but
   * no specific `platform` identifier yet (e.g. "connected device looks
   * like a Jetson — which module is authoritative here?").
   *
   * Conflict resolution when multiple modules declare the same family
   * mirrors `findModuleForPlatform`: sort by
   * `platformClaimPriority DESC` then `id ASC`, and return the winner.
   *
   * Leaving this `undefined` is legal — the module is still reachable
   * via `getKnowledgeModule(id)` and `findModuleForPlatform(platform)`.
   */
  family?: DeviceFamily;

  /**
   * Optional ordered list of other knowledge module ids this module depends on.
   *
   * Intended for reviewer-time documentation and registry-side cycle
   * detection — NOT for runtime lazy-loading or initialization order.
   * The registry logs a warning (via `log.warn`) when a cycle is
   * detected (e.g. `A -> B -> A`) but never throws, so agent startup
   * remains resilient against misconfigured third-party modules.
   *
   * Only direct dependency cycles (2-node, `A <-> B`) are detected in
   * the initial implementation; longer cycles are an acknowledged
   * trade-off and may be added later if real-world data shows they
   * matter.
   */
  dependencies?: string[];

  /** Device profiles indexed by platform */
  getDeviceProfiles(): Record<string, DeviceProfileBase>;

  /** Documentation index for search and prompt injection */
  getDocIndex(): DocIndexEntry[];

  /** Prompt fragments to inject into system prompt */
  getPromptFragments(): PromptFragment[];

  /** Command semantics for tool execution analysis */
  getCommandPatterns(): CommandPattern[];

  /** Failure hints for error recovery */
  getFailureHints(): FailureHint[];

  /** Brand/product ecosystem context */
  getEcosystemPrompt(): string;

  /** Optional: initial research seeds for device diagnostics */
  getResearchSeeds?(platform: string): string[];

  /**
   * Optional: skills this module endorses as domain-native.
   *
   * Use this to declare ownership of existing SKILL.md files (discovered
   * by the host) so downstream skill routing can rank them higher when
   * this module's platforms are active. The module does NOT need to
   * physically bundle the SKILL.md content — the host remains the
   * source of truth for skill file storage.
   *
   * Returning an empty array (or omitting this method) means the module
   * does not endorse any specific skills; matching then falls back to
   * plain text/trigger matching.
   */
  getSkills?(): EndorsedSkillRef[];
}
