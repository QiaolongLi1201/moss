import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigDir } from './config.js';

const AUTH_SCHEMA = 'dmoss_community_auth.v1';
const DEFAULT_SSO_BASE_URL = 'https://sso.d-robotics.cc';
const CALLBACK_PATH = '/dmoss/community-auth/callback';
const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const EXPIRY_SKEW_MS = 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 30_000;

const TOKEN_QUERY_KEYS = [
  'token',
  'access_token',
  'accessToken',
  'bearer',
  'id_token',
  'jwt',
  'auth_token',
  'ticket',
  'authorization',
] as const;

export interface DmossCommunityUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
}

export interface DmossCommunityAuthSession {
  schema: typeof AUTH_SCHEMA;
  ssoBaseUrl: string;
  accessToken: string;
  user: DmossCommunityUser;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface DmossCommunityAuthContext {
  accessToken: string;
  user: DmossCommunityUser;
  expiresAt: number;
  sessionPath: string;
  ssoBaseUrl: string;
}

export interface DmossCommunityAuthStatus {
  authenticated: boolean;
  sessionPath: string;
  ssoBaseUrl: string;
  user?: DmossCommunityUser;
  expiresAt?: number;
  reason?: 'missing' | 'expired' | 'invalid';
}

export interface DmossCommunityAuthRuntime {
  getStatus(): DmossCommunityAuthStatus;
  getContext(): DmossCommunityAuthContext | undefined;
  login(print?: (line: string) => void): Promise<DmossCommunityAuthContext>;
  logout(): boolean;
}

export class DmossCommunityAuthRequiredError extends Error {
  constructor(message = renderCommunityAuthRequiredMessage()) {
    super(message);
    this.name = 'DmossCommunityAuthRequiredError';
  }
}

type FetchImpl = typeof fetch;

function normalizeSsoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DMOSS_COMMUNITY_SSO_BASE_URL || env.DMOSS_SSO_BASE_URL || DEFAULT_SSO_BASE_URL;
  return raw.trim().replace(/\/+$/, '') || DEFAULT_SSO_BASE_URL;
}

export function resolveCommunityAuthSessionPath(configDir = resolveConfigDir()): string {
  return path.join(configDir, 'community-auth.json');
}

function normalizePortalToken(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let token = raw.trim();
  if (!token) return '';
  if (token.includes('%')) {
    try {
      token = decodeURIComponent(token);
    } catch {
      // Keep the original token if it was not valid percent-encoding.
    }
  }
  token = token.replace(/^Bearer\s+/i, '').trim();
  token = token.replace(/\s+/g, '+');
  return token.length >= 8 ? token : '';
}

function readTokenFromUrl(url: URL): string {
  for (const key of TOKEN_QUERY_KEYS) {
    const token = normalizePortalToken(url.searchParams.get(key));
    if (token) return token;
  }
  const known = new Set(TOKEN_QUERY_KEYS.map((key) => key.toLowerCase()));
  for (const [key, value] of url.searchParams.entries()) {
    if (!known.has(key.toLowerCase())) continue;
    const token = normalizePortalToken(value);
    if (token) return token;
  }

  // The SSO portal appends "?bearer=..." to redirectUrl even if redirectUrl
  // already contains a query string. Accept the resulting
  // "?state=abc?bearer=token" shape so old login URLs still complete.
  const rawSearch = url.search || '';
  for (const key of TOKEN_QUERY_KEYS) {
    const match = rawSearch.match(new RegExp(`[?&]${key}=([^&]+)`, 'i'));
    const token = normalizePortalToken(match?.[1]);
    if (token) return token;
  }
  return '';
}

function readCallbackState(url: URL): string {
  if (url.pathname.startsWith(`${CALLBACK_PATH}/`)) {
    return decodeURIComponent(url.pathname.slice(CALLBACK_PATH.length + 1)).trim();
  }
  return String(url.searchParams.get('state') || '').split(/[?&]/)[0].trim();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function userFromClaims(claims: Record<string, unknown> | null): DmossCommunityUser | null {
  if (!claims) return null;
  const id = String(claims.sub || claims.id || claims.user_id || claims.userId || '').trim();
  if (!id) return null;
  const name = String(
    claims.name ||
      claims.preferred_username ||
      claims.username ||
      claims.nickname ||
      '',
  ).trim();
  const email = String(claims.email || '').trim();
  const avatar = typeof claims.picture === 'string' ? claims.picture : undefined;
  return {
    id,
    name: name || email || id,
    ...(email ? { email } : {}),
    ...(avatar ? { avatar } : {}),
  };
}

function expiresAtFromClaims(claims: Record<string, unknown> | null): number | null {
  const exp = typeof claims?.exp === 'number' ? claims.exp : Number(claims?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp * 1000;
}

function userFromVerifiedOpaqueToken(accessToken: string): DmossCommunityUser {
  const digest = crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 24);
  return {
    id: `portal:${digest}`,
    name: 'D-Robotics User',
  };
}

async function fetchUserinfo(
  ssoBaseUrl: string,
  accessToken: string,
  fetchImpl: FetchImpl,
): Promise<DmossCommunityUser | null> {
  const res = await fetchImpl(`${ssoBaseUrl}/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('D-Robotics community token is invalid or expired');
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return userFromClaims({
    ...data,
    sub: data.sub || data.id || data.user_id,
    name: data.name || data.username || data.nickname,
    picture: data.picture,
  });
}

async function verifyPortalTokenWithPermissionApi(
  ssoBaseUrl: string,
  accessToken: string,
  fetchImpl: FetchImpl,
): Promise<boolean> {
  for (const authorization of [accessToken, `Bearer ${accessToken}`]) {
    try {
      const res = await fetchImpl(`${ssoBaseUrl}/api/userCenterApi/permission/getPermission`, {
        headers: {
          SourceApp: 'getway-sso',
          'x-request-id': crypto.randomUUID(),
          Authorization: authorization,
        },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && Number(data.status) === 0) return true;
    } catch {
      // Try the alternate Authorization form.
    }
  }
  return false;
}

export async function resolveCommunityUserFromToken(
  accessToken: string,
  options: {
    ssoBaseUrl?: string;
    fetchImpl?: FetchImpl;
  } = {},
): Promise<{ user: DmossCommunityUser; expiresAt: number }> {
  const token = normalizePortalToken(accessToken);
  if (!token) {
    throw new Error('D-Robotics community token is missing');
  }
  const ssoBaseUrl = options.ssoBaseUrl || normalizeSsoBaseUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  const claims = decodeJwtPayload(token);
  const jwtUser = userFromClaims(claims);
  const jwtExpiresAt = expiresAtFromClaims(claims);
  if (jwtExpiresAt !== null && jwtExpiresAt <= Date.now() + EXPIRY_SKEW_MS) {
    throw new Error('D-Robotics community token is expired');
  }

  try {
    const userinfoUser = await fetchUserinfo(ssoBaseUrl, token, fetchImpl);
    if (userinfoUser) {
      return {
        user: userinfoUser,
        expiresAt: jwtExpiresAt ?? Date.now() + DEFAULT_SESSION_TTL_MS,
      };
    }
  } catch (err) {
    if (err instanceof Error && /invalid|expired/i.test(err.message)) throw err;
  }

  if (await verifyPortalTokenWithPermissionApi(ssoBaseUrl, token, fetchImpl)) {
    return {
      user: jwtUser ?? userFromVerifiedOpaqueToken(token),
      expiresAt: jwtExpiresAt ?? Date.now() + DEFAULT_SESSION_TTL_MS,
    };
  }

  throw new Error('D-Robotics community token could not be verified');
}

function parseStoredSession(raw: unknown): DmossCommunityAuthSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<DmossCommunityAuthSession>;
  if (value.schema !== AUTH_SCHEMA) return null;
  if (typeof value.accessToken !== 'string' || !value.accessToken.trim()) return null;
  if (!value.user || typeof value.user !== 'object') return null;
  if (typeof value.user.id !== 'string' || !value.user.id.trim()) return null;
  if (typeof value.user.name !== 'string') return null;
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null;
  return value as DmossCommunityAuthSession;
}

export function readDmossCommunityAuthSession(
  configDir = resolveConfigDir(),
): DmossCommunityAuthSession | null {
  const sessionPath = resolveCommunityAuthSessionPath(configDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as unknown;
    return parseStoredSession(parsed);
  } catch {
    return null;
  }
}

export function getDmossCommunityAuthStatus(options: {
  configDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): DmossCommunityAuthStatus {
  const configDir = options.configDir ?? resolveConfigDir(options.env);
  const sessionPath = resolveCommunityAuthSessionPath(configDir);
  const ssoBaseUrl = normalizeSsoBaseUrl(options.env);
  const session = readDmossCommunityAuthSession(configDir);
  if (!session) {
    return { authenticated: false, reason: 'missing', sessionPath, ssoBaseUrl };
  }
  if (session.expiresAt <= Date.now() + EXPIRY_SKEW_MS) {
    return { authenticated: false, reason: 'expired', sessionPath, ssoBaseUrl, user: session.user, expiresAt: session.expiresAt };
  }
  return {
    authenticated: true,
    sessionPath,
    ssoBaseUrl,
    user: session.user,
    expiresAt: session.expiresAt,
  };
}

export function writeDmossCommunityAuthSession(
  session: DmossCommunityAuthSession,
  configDir = resolveConfigDir(),
): string {
  const sessionPath = resolveCommunityAuthSessionPath(configDir);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(sessionPath, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
  return sessionPath;
}

export function clearDmossCommunityAuthSession(configDir = resolveConfigDir()): boolean {
  const sessionPath = resolveCommunityAuthSessionPath(configDir);
  try {
    if (!fs.existsSync(sessionPath)) return false;
    fs.rmSync(sessionPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): boolean {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function tokenRelayHtml(): string {
  const keys = JSON.stringify(TOKEN_QUERY_KEYS);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>D-Moss Login</title></head><body>
<script>
(function(){
  var keys = ${keys};
  var hash = String(location.hash || '').replace(/^#/, '');
  var params = new URLSearchParams(hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : hash);
  var token = '';
  for (var i = 0; i < keys.length; i++) {
    token = params.get(keys[i]) || '';
    if (token) break;
  }
  if (token) {
    var u = new URL(location.href);
    u.hash = '';
    u.searchParams.set('token', token);
    location.replace(u.toString());
    return;
  }
  document.body.textContent = 'D-Moss login returned without a usable token. Please return to the terminal and try again.';
})();
</script>
</body></html>`;
}

function errorHtml(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>D-Moss Login</title></head><body>
<p>D-Moss login failed: ${escapeHtml(message)}</p>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function successHtml(): string {
  return '<!doctype html><html><body>D-Moss login received. You can return to the terminal.</body></html>';
}

function buildPortalLoginUrl(ssoBaseUrl: string, callbackUrl: string): string {
  return `${ssoBaseUrl}/?redirectUrl=${encodeURIComponent(callbackUrl)}`;
}

async function waitForCommunityLoginToken(options: {
  ssoBaseUrl: string;
  print: (line: string) => void;
  openBrowser: boolean;
}): Promise<{ token: string; server: http.Server }> {
  const state = crypto.randomBytes(16).toString('hex');
  let settled = false;
  let server: http.Server | undefined;
  const tokenPromise = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH && !url.pathname.startsWith(`${CALLBACK_PATH}/`)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const token = readTokenFromUrl(url);
      if (!token) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(tokenRelayHtml());
        return;
      }
      if (readCallbackState(url) !== state) {
        const message = 'login state mismatch';
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorHtml(message));
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(successHtml());
      if (!settled) {
        settled = true;
        resolve(token);
      }
    });
    server.once('error', reject);
  });

  if (!server) throw new Error('failed to create localhost callback server');
  const activeServer = server;
  activeServer.keepAliveTimeout = 1000;

  await new Promise<void>((resolve, reject) => {
    activeServer.listen(0, '127.0.0.1', () => resolve());
    activeServer.once('error', reject);
  });

  const address = activeServer.address();
  if (!address || typeof address === 'string') {
    activeServer.close();
    throw new Error('failed to bind localhost callback server');
  }

  const callbackUrl = `http://127.0.0.1:${address.port}${CALLBACK_PATH}/${encodeURIComponent(state)}`;
  const loginUrl = buildPortalLoginUrl(options.ssoBaseUrl, callbackUrl);
  options.print('[auth] D-Moss requires a D-Robotics developer community login.');
  options.print(`[auth] Login URL: ${loginUrl}`);
  if (options.openBrowser) {
    const opened = openExternalUrl(loginUrl);
    if (!opened) options.print('[auth] Could not open a browser automatically. Paste the URL above into your browser.');
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('timed out waiting for D-Robotics login')), LOGIN_TIMEOUT_MS);
    timeoutHandle.unref?.();
  });
  try {
    return { token: await Promise.race([tokenPromise, timeout]), server: activeServer };
  } catch (err) {
    activeServer.close();
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function runDmossCommunityAuthLogin(options: {
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  openBrowser?: boolean;
  print?: (line: string) => void;
} = {}): Promise<DmossCommunityAuthContext> {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? resolveConfigDir(env);
  const ssoBaseUrl = normalizeSsoBaseUrl(env);
  const print = options.print ?? ((line: string) => console.error(line));
  const { token, server } = await waitForCommunityLoginToken({
    ssoBaseUrl,
    print,
    openBrowser: options.openBrowser ?? true,
  });

  try {
    const verified = await resolveCommunityUserFromToken(token, {
      ssoBaseUrl,
      fetchImpl: options.fetchImpl,
    });
    const now = Date.now();
    const session: DmossCommunityAuthSession = {
      schema: AUTH_SCHEMA,
      ssoBaseUrl,
      accessToken: token,
      user: verified.user,
      expiresAt: verified.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    const sessionPath = writeDmossCommunityAuthSession(session, configDir);
    print(`[auth] Logged in as ${verified.user.name || verified.user.email || verified.user.id}`);
    return {
      accessToken: token,
      user: verified.user,
      expiresAt: verified.expiresAt,
      sessionPath,
      ssoBaseUrl,
    };
  } finally {
    server.close();
  }
}

export function renderCommunityAuthRequiredMessage(options: { interactive?: boolean } = {}): string {
  if (options.interactive) {
    return [
      'D-Moss requires a D-Robotics developer community login before use.',
      '',
      'Run this inside D-Moss:',
      '  /auth login',
      '',
      'Then ask Moss again in this session.',
    ].join(os.EOL);
  }
  return [
    'D-Moss requires a D-Robotics developer community login before use.',
    '',
    'Run:',
    '  dmoss auth login',
    '',
    'Then start dmoss again.',
  ].join(os.EOL);
}

export function formatCommunityAuthStatus(status: DmossCommunityAuthStatus): string {
  if (!status.authenticated) {
    if (status.reason === 'expired') return `expired; run dmoss auth login (${status.sessionPath})`;
    if (status.reason === 'invalid') return `invalid; run dmoss auth login (${status.sessionPath})`;
    return `not logged in; run dmoss auth login (${status.sessionPath})`;
  }
  const user = status.user;
  const name = user ? user.name || user.email || user.id : 'unknown user';
  const expiry = status.expiresAt ? new Date(status.expiresAt).toISOString() : 'unknown expiry';
  return `logged in as ${name}; expires ${expiry}`;
}

export async function ensureDmossCommunityAuth(options: {
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  fetchImpl?: FetchImpl;
} = {}): Promise<DmossCommunityAuthContext> {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? resolveConfigDir(env);
  const status = getDmossCommunityAuthStatus({ configDir, env });
  const session = readDmossCommunityAuthSession(configDir);
  if (status.authenticated && session) {
    return {
      accessToken: session.accessToken,
      user: session.user,
      expiresAt: session.expiresAt,
      sessionPath: status.sessionPath,
      ssoBaseUrl: status.ssoBaseUrl,
    };
  }

  if (!options.interactive) {
    throw new DmossCommunityAuthRequiredError();
  }

  return runDmossCommunityAuthLogin({
    configDir,
    env,
    fetchImpl: options.fetchImpl,
    openBrowser: true,
  });
}
