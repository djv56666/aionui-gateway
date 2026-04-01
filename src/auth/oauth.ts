/**
 * OAuth2 service — handles Authorization Code flow for multiple providers.
 *
 * Intentionally avoids heavy dependencies like passport.js.
 * Each provider is a simple { authorizeUrl, tokenUrl, userInfoUrl, scopes } config
 * and the exchange logic is plain fetch().
 */

import crypto from 'node:crypto';
import { config } from '../config/index.js';
import type { OAuthProvider } from '../types/index.js';

export type { OAuthProvider };

// ─── Provider configurations ──────────────────────────

interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  /**
   * How the token endpoint returns data:
   * - 'json' (default): standard JSON { access_token, ... }
   * - 'query-string': CAS-style key=value&key=value (e.g. access_token=AT-xxx&expires_in=28800)
   */
  tokenResponseFormat?: 'json' | 'query-string';
  /**
   * How to pass access_token to the user-info endpoint:
   * - 'bearer' (default): Authorization: Bearer <token>
   * - 'query': ?access_token=<token> as URL parameter
   */
  userInfoTokenTransport?: 'bearer' | 'query';
}

function getProviderConfig(provider: OAuthProvider): OAuthProviderConfig | null {
  switch (provider) {
    case 'github':
      if (!config.oauth.github.enabled) return null;
      return {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
        scopes: ['read:user', 'user:email'],
        clientId: config.oauth.github.clientId,
        clientSecret: config.oauth.github.clientSecret,
      };

    case 'google':
      if (!config.oauth.google.enabled) return null;
      return {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
        scopes: ['openid', 'profile', 'email'],
        clientId: config.oauth.google.clientId,
        clientSecret: config.oauth.google.clientSecret,
      };

    case 'zhimi': {
      if (!config.oauth.zhimi.enabled) return null;
      const casBase = config.oauth.zhimi.casBase;
      return {
        authorizeUrl: `${casBase}/oauth2.0/authorize`,
        tokenUrl: `${casBase}/oauth2.0/accessToken`,
        userInfoUrl: `${casBase}/oauth2.0/profile`,
        scopes: [],  // CAS does not use scopes
        clientId: config.oauth.zhimi.clientId,
        clientSecret: config.oauth.zhimi.clientSecret,
        tokenResponseFormat: 'query-string',
        userInfoTokenTransport: 'query',
      };
    }

    case 'feishu':
      if (!config.oauth.feishu.enabled) return null;
      return {
        authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/authorize',
        tokenUrl: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        userInfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
        scopes: [],
        clientId: config.oauth.feishu.clientId,
        clientSecret: config.oauth.feishu.clientSecret,
      };

    default:
      return null;
  }
}

// ─── State management (CSRF protection) ───────────────

const pendingStates = new Map<string, { provider: OAuthProvider; expiresAt: number }>();

/** Clean up expired states every 5 minutes */
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (now > val.expiresAt) pendingStates.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ─── Public API ───────────────────────────────────────

export interface OAuthUserInfo {
  provider: OAuthProvider;
  oauthId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  email: string | null;
}

/**
 * Build the authorization URL for a provider.
 * Returns null if provider is not configured.
 */
export function buildAuthorizeUrl(
  provider: OAuthProvider,
  callbackUrl: string,
): { url: string; state: string } | null {
  const cfg = getProviderConfig(provider);
  if (!cfg) return null;

  const state = crypto.randomBytes(20).toString('hex');
  pendingStates.set(state, { provider, expiresAt: Date.now() + 10 * 60 * 1000 });

  // Feishu uses app_id instead of client_id and doesn't require response_type/scope
  if (provider === 'feishu') {
    const params = new URLSearchParams({
      app_id: cfg.clientId,
      redirect_uri: callbackUrl,
      state,
    });
    return { url: `${cfg.authorizeUrl}?${params.toString()}`, state };
  }

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl,
    state,
    response_type: 'code',
  });

  // Only add scope if provider requires it
  if (cfg.scopes.length > 0) {
    params.set('scope', cfg.scopes.join(' '));
  }

  // Google requires access_type for refresh tokens
  if (provider === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }

  return { url: `${cfg.authorizeUrl}?${params.toString()}`, state };
}

/**
 * Validate the state parameter from the callback.
 */
export function validateState(state: string): OAuthProvider | null {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingStates.delete(state);
    return null;
  }
  pendingStates.delete(state);
  return entry.provider;
}

/**
 * Exchange authorization code for user info.
 */
export async function exchangeCodeForUser(
  provider: OAuthProvider,
  code: string,
  callbackUrl: string,
): Promise<OAuthUserInfo | null> {
  const cfg = getProviderConfig(provider);
  if (!cfg) return null;

  // Feishu requires a two-step token exchange:
  // 1) Get app_access_token
  // 2) Use it to exchange code for user_access_token
  if (provider === 'feishu') {
    return exchangeFeishuCode(cfg, code);
  }

  // Step 1: Exchange code for access token
  const tokenRes = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    console.error(`[oauth] Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    return null;
  }

  // Parse token response — some providers (CAS) return query-string format
  let accessToken: string | undefined;

  if (cfg.tokenResponseFormat === 'query-string') {
    const rawText = await tokenRes.text();
    const parsed = new URLSearchParams(rawText);
    accessToken = parsed.get('access_token') || undefined;
    if (!accessToken) {
      console.error('[oauth] No access_token in query-string response:', rawText);
      return null;
    }
  } else {
    const tokenData = (await tokenRes.json()) as Record<string, unknown>;
    accessToken = tokenData.access_token as string | undefined;
    if (!accessToken) {
      console.error('[oauth] No access_token in JSON response:', tokenData);
      return null;
    }
  }

  // Step 2: Fetch user info
  let userInfoUrl = cfg.userInfoUrl;
  const userInfoHeaders: Record<string, string> = { Accept: 'application/json' };

  if (cfg.userInfoTokenTransport === 'query') {
    // CAS-style: pass token as query parameter
    const separator = userInfoUrl.includes('?') ? '&' : '?';
    userInfoUrl = `${userInfoUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;
  } else {
    // Standard: Bearer token in Authorization header
    userInfoHeaders['Authorization'] = `Bearer ${accessToken}`;
  }

  const userRes = await fetch(userInfoUrl, { headers: userInfoHeaders });

  if (!userRes.ok) {
    console.error(`[oauth] User info fetch failed: ${userRes.status}`);
    return null;
  }

  const userData = (await userRes.json()) as Record<string, unknown>;

  // Step 3: Normalize to OAuthUserInfo
  return normalizeUserInfo(provider, userData, accessToken);
}

/**
 * Feishu-specific two-step code exchange:
 * 1) POST /auth/v3/tenant_access_token/internal → tenant_access_token
 * 2) POST /authen/v1/oidc/access_token          → user_access_token
 */
async function exchangeFeishuCode(
  cfg: OAuthProviderConfig,
  code: string,
): Promise<OAuthUserInfo | null> {
  // Step 1: Get tenant_access_token
  const appTokenRes = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: cfg.clientId,
      app_secret: cfg.clientSecret,
    }),
  });

  if (!appTokenRes.ok) {
    console.error(`[oauth] Feishu app_access_token failed: ${appTokenRes.status} ${await appTokenRes.text()}`);
    return null;
  }

  const tokenData = (await appTokenRes.json()) as { code?: number; tenant_access_token?: string };
  const tenantAccessToken = tokenData.tenant_access_token;
  if (!tenantAccessToken) {
    console.error('[oauth] No tenant_access_token in Feishu response:', JSON.stringify(tokenData));
    return null;
  }

  // Step 2: Exchange code for user_access_token
  const codeRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tenantAccessToken}`,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
    }),
  });

  if (!codeRes.ok) {
    console.error(`[oauth] Feishu code exchange failed: ${codeRes.status} ${await codeRes.text()}`);
    return null;
  }

  const codeData = (await codeRes.json()) as { code?: number; data?: { access_token?: string } };
  const userAccessToken = codeData?.data?.access_token;
  if (!userAccessToken) {
    console.error('[oauth] No user_access_token in Feishu code exchange:', JSON.stringify(codeData));
    return null;
  }

  // Step 3: Fetch user info with user_access_token
  const userRes = await fetch(cfg.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      Accept: 'application/json',
    },
  });

  if (!userRes.ok) {
    console.error(`[oauth] Feishu user info fetch failed: ${userRes.status}`);
    return null;
  }

  const userData = (await userRes.json()) as Record<string, unknown>;
  return normalizeFeishu(userData);
}

// ─── Provider-specific normalization ──────────────────

async function normalizeUserInfo(
  provider: OAuthProvider,
  data: Record<string, unknown>,
  accessToken: string,
): Promise<OAuthUserInfo> {
  switch (provider) {
    case 'github':
      return normalizeGitHub(data, accessToken);
    case 'google':
      return normalizeGoogle(data);
    case 'zhimi':
      return normalizeZhimi(data);
    case 'feishu':
      return normalizeFeishu(data);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function normalizeGitHub(
  data: Record<string, unknown>,
  accessToken: string,
): Promise<OAuthUserInfo> {
  let email = (data.email as string) || null;

  // GitHub may not return email in profile — fetch from /user/emails
  if (!email) {
    try {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (emailRes.ok) {
        const emails = (await emailRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email || emails[0]?.email || null;
      }
    } catch {
      // Ignore email fetch failure
    }
  }

  return {
    provider: 'github',
    oauthId: String(data.id),
    username: (data.login as string) || `gh-${data.id}`,
    displayName: (data.name as string) || (data.login as string) || '',
    avatarUrl: (data.avatar_url as string) || '',
    email,
  };
}

function normalizeGoogle(data: Record<string, unknown>): OAuthUserInfo {
  return {
    provider: 'google',
    oauthId: data.id as string,
    username: (data.email as string)?.split('@')[0] || `g-${data.id}`,
    displayName: (data.name as string) || '',
    avatarUrl: (data.picture as string) || '',
    email: (data.email as string) || null,
  };
}

/**
 * Normalize Zhimi CAS profile response.
 * Response format: { id: "lixx32", name: "***", phone: "132****3981", email: "lixx32@zhimi.com" }
 */
function normalizeZhimi(data: Record<string, unknown>): OAuthUserInfo {
  const userId = data.id as string;
  return {
    provider: 'zhimi',
    oauthId: userId,
    username: userId,
    displayName: (data.name as string) || userId,
    avatarUrl: '', // CAS does not provide avatar
    email: (data.email as string) || null,
  };
}

/**
 * Normalize Feishu v1 authen API response.
 * Response format: { code: 0, data: { open_id, user_id, name, email, avatar_url, ... } }
 */
function normalizeFeishu(data: Record<string, unknown>): OAuthUserInfo {
  const userInfo = (data.data as Record<string, unknown>) || data;

  const openId = userInfo.open_id as string;
  const userId = userInfo.user_id as string;
  const email = userInfo.email as string | null;
  const name = (userInfo.name as string) || openId || userId;
  const avatarUrl = (userInfo.avatar_url as string) || '';

  return {
    provider: 'feishu',
    oauthId: openId || userId,
    username: email ? email.split('@')[0] : (openId || userId),
    displayName: name,
    avatarUrl,
    email,
  };
}

/**
 * Get list of enabled providers.
 */
export function getEnabledProviders(): OAuthProvider[] {
  const providers: OAuthProvider[] = [];
  if (config.oauth.zhimi.enabled) providers.push('zhimi');
  if (config.oauth.github.enabled) providers.push('github');
  if (config.oauth.google.enabled) providers.push('google');
  if (config.oauth.feishu.enabled) providers.push('feishu');
  return providers;
}
