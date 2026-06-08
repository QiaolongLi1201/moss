import { buildApiV1Url } from '../provider/api-v1-url.js';
import {
  normalizeProvider,
  PROVIDER_PRESETS,
  type CliProviderPreset,
  type ResolvedCliConfig,
} from './config.js';

export interface ModelChoice {
  provider: CliProviderPreset;
  model: string;
  label?: string;
  source: 'live' | 'built-in' | 'common' | 'current';
}

export interface ModelChoiceList {
  provider: CliProviderPreset;
  providerLabel: string;
  currentModel: string;
  choices: ModelChoice[];
  source: 'live' | 'built-in' | 'common';
  warning?: string;
}

const COMMON_MODELS: Record<CliProviderPreset, string[]> = {
  deepseek: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  qwen: ['qwen3.7-max', 'qwen-plus', 'qwen-max', 'qwen-coder-plus'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-5', 'gpt-5-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-7', 'claude-haiku-4-5'],
  'openai-compatible': ['gpt-4o-mini', 'gpt-4o', 'qwen-plus', 'deepseek-chat'],
};

function uniqueModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const model = raw.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

function providerFromRuntime(config?: Partial<ResolvedCliConfig>, fallbackProvider?: string): CliProviderPreset {
  return normalizeProvider(config?.provider || fallbackProvider || 'openai-compatible');
}

export function commonModelChoices(
  provider: CliProviderPreset,
  currentModel = '',
  options: { usingBundledDefault?: boolean } = {},
): ModelChoice[] {
  const models = uniqueModels([
    currentModel,
    options.usingBundledDefault ? 'Moss' : '',
    PROVIDER_PRESETS[provider].defaultModel,
    ...(COMMON_MODELS[provider] ?? []),
  ]);
  return models.map((model) => ({
    provider,
    model,
    label: model === 'Moss' && options.usingBundledDefault ? 'built-in D-Robotics model' : undefined,
    source: model === currentModel ? 'current' : model === 'Moss' && options.usingBundledDefault ? 'built-in' : 'common',
  }));
}

function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown; name?: unknown }).id;
    const name = (item as { id?: unknown; name?: unknown }).name;
    if (typeof id === 'string' && id.trim()) models.push(id.trim());
    else if (typeof name === 'string' && name.trim()) models.push(name.trim());
  }
  return uniqueModels(models);
}

async function fetchOpenAiCompatibleModels(
  config: Partial<ResolvedCliConfig>,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  if (!config.baseUrl || !config.apiKey) return [];
  const timeoutMs = options.timeoutMs ?? 2500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(buildApiV1Url(config.baseUrl, 'models'), {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    return parseModelIds(await res.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function loadModelChoicesForRuntime(
  config?: Partial<ResolvedCliConfig>,
  currentModel = '',
  options: { fallbackProvider?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelChoiceList> {
  const provider = providerFromRuntime(config, options.fallbackProvider);
  const providerLabel = PROVIDER_PRESETS[provider].displayName;
  const canFetchLive = provider !== 'anthropic' && Boolean(config?.baseUrl && config?.apiKey);
  const liveModels = canFetchLive
    ? await fetchOpenAiCompatibleModels(config ?? {}, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl })
    : [];
  if (liveModels.length > 0) {
    const choices = uniqueModels([currentModel, ...liveModels]).slice(0, 50).map((model): ModelChoice => ({
      provider,
      model,
      source: model === currentModel ? 'current' : 'live',
    }));
    return {
      provider,
      providerLabel,
      currentModel,
      choices,
      source: config?.usingBundledDefault ? 'built-in' : 'live',
    };
  }
  return {
    provider,
    providerLabel,
    currentModel,
    choices: commonModelChoices(provider, currentModel, {
      usingBundledDefault: config?.usingBundledDefault,
    }),
    source: config?.usingBundledDefault ? 'built-in' : 'common',
    warning: canFetchLive ? 'Live model list was unavailable; showing common model names for this provider.' : undefined,
  };
}

export function resolveModelSelection(input: string, choices: readonly ModelChoice[]): ModelChoice | null {
  const raw = input.trim();
  if (!raw) return null;
  const numeric = Number.parseInt(raw, 10);
  if (/^\d+$/.test(raw) && numeric >= 1 && numeric <= choices.length) return choices[numeric - 1] ?? null;
  const normalized = raw.toLowerCase();
  const providerQualified = normalized.includes('/') ? normalized : '';
  return choices.find((choice) => {
    if (choice.model.toLowerCase() === normalized) return true;
    return providerQualified === `${choice.provider}/${choice.model}`.toLowerCase();
  }) ?? null;
}

export function formatModelChoices(list: ModelChoiceList): string {
  const lines = [
    'Models',
    `  active provider  ${list.providerLabel} (${list.provider})`,
    `  current model    ${list.currentModel || '(not set)'}`,
    `  source           ${list.source === 'live' ? 'provider /v1/models' : list.source === 'built-in' ? 'built-in default' : 'common examples'}`,
  ];
  if (list.warning) lines.push(`  note             ${list.warning}`);
  lines.push('', 'Choose for this session:');
  list.choices.forEach((choice, index) => {
    const current = choice.model === list.currentModel ? ' current' : '';
    const label = choice.label ? ` - ${choice.label}` : '';
    lines.push(`  ${String(index + 1).padStart(2, ' ')}. ${choice.model}${label}${current}`);
  });
  lines.push(
    '',
    'Use:',
    '  /model <number>        choose one of the models above',
    '  /model <model-name>    use a custom model name for this session',
    '  moss setup             change provider, base URL, or API key',
  );
  return lines.join('\n');
}
