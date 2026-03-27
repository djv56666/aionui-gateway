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
 * Get list of enabled providers.
 */
export function getEnabledProviders(): OAuthProvider[] {
  const providers: OAuthProvider[] = [];
  if (config.oauth.zhimi.enabled) providers.push('zhimi');
  if (config.oauth.github.enabled) providers.push('github');
  if (config.oauth.google.enabled) providers.push('google');
  return providers;
}
