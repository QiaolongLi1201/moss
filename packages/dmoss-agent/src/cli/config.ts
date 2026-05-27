import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL } from '@dmoss/core';

export function resolveConfigDir(): string {
  const explicit = process.env.DMOSS_CONFIG_DIR;
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dmoss');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dmoss');
}

export interface ConfigFile {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  workspace?: string;
}

export function loadConfigFile(): ConfigFile {
  const configPath = path.join(resolveConfigDir(), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return {};
  }
}

export function loadEnvFile(envPath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadEnvFromAncestors(startDir: string, maxHops = 16): void {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxHops; i++) {
    loadEnvFile(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadEnvFromAncestors(process.cwd());
loadEnvFromAncestors(path.dirname(fileURLToPath(import.meta.url)));

const configFile = loadConfigFile();

export const API_KEY = process.env.DMOSS_API_KEY || process.env.OPENAI_API_KEY || configFile.apiKey || '';
export const MODEL = process.env.DMOSS_MODEL || configFile.model || DEFAULT_MODEL;
export const BASE_URL =
  process.env.DMOSS_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  configFile.baseUrl ||
  'https://api.anthropic.com';
export const WORKSPACE = process.env.DMOSS_WORKSPACE || configFile.workspace || process.cwd();
