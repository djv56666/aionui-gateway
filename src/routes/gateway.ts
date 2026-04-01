/**
 * Gateway routes — OAuth2 login flow & gateway pages.
 * All routes are mounted under /gateway/*
 */

import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  buildAuthorizeUrl,
  validateState,
  exchangeCodeForUser,
  getEnabledProviders,
  type OAuthProvider,
} from '../auth/oauth.js';
import { findUserByOAuth, createUser, updateUserLogin } from '../database/index.js';
import { guestOnly } from '../middleware/auth.js';
import { config } from '../config/index.js';

interface GatewaySession {
  userId?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  [key: string]: unknown;
}

export function createGatewayRouter(): Router {
  const router = Router();

  // ─── Login page ─────────────────────────────────────

  router.get('/login', guestOnly, (_req: Request, res: Response) => {
    const providers = getEnabledProviders();
    res.send(buildLoginPage(providers));
  });

  // ─── OAuth2: Initiate flow ──────────────────────────

  router.get('/oauth/:provider', (req: Request, res: Response) => {
    const provider = req.params.provider as OAuthProvider;
    const callbackUrl = `${getBaseUrl(req)}/gateway/oauth/${provider}/callback`;

    const result = buildAuthorizeUrl(provider, callbackUrl);
    if (!result) {
      res.status(400).send('OAuth provider not configured');
      return;
    }

    res.redirect(result.url);
  });

  // ─── OAuth2: Callback ───────────────────────────────

  router.get('/oauth/:provider/callback', async (req: Request, res: Response) => {
    const { code, state } = req.query;

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).send('Missing code or state parameter');
      return;
    }

    // Validate CSRF state
    const provider = validateState(state);
    if (!provider) {
      res.status(403).send('Invalid or expired state parameter');
      return;
    }

    // Exchange code for user info
    const callbackUrl = `${getBaseUrl(req)}/gateway/oauth/${provider}/callback`;
    const oauthUser = await exchangeCodeForUser(provider, code, callbackUrl);
    if (!oauthUser) {
      res.status(401).send('OAuth authentication failed');
      return;
    }

    // Find or create local user
    let user = findUserByOAuth(oauthUser.provider, oauthUser.oauthId);
    if (!user) {
      user = createUser({
        id: uuidv4(),
        oauthProvider: oauthUser.provider,
        oauthId: oauthUser.oauthId,
        username: oauthUser.username,
        displayName: oauthUser.displayName,
        avatarUrl: oauthUser.avatarUrl,
        email: oauthUser.email,
        createdAt: Date.now(),
        lastLogin: Date.now(),
      });
      console.log(`[auth] New user created: ${user.username} (${user.oauthProvider})`);
    } else {
      updateUserLogin(user.id);
      console.log(`[auth] User logged in: ${user.username} (${user.oauthProvider})`);
    }

    // Set session
    const session = req.session as unknown as GatewaySession;
    session.userId = user.id;
    session.username = user.username;
    session.displayName = user.displayName || user.username;
    session.avatarUrl = user.avatarUrl;

    // Redirect to loading page while container starts
    res.redirect('/gateway/loading');
  });

  // ─── Logout ─────────────────────────────────────────

  router.post('/logout', (req: Request, res: Response) => {
    req.session = null;
    res.redirect('/gateway/login');
  });

  // ─── Status (for AJAX checks) ──────────────────────

  router.get('/status', (req: Request, res: Response) => {
    const session = req.session as unknown as GatewaySession | undefined;
    res.json({
      authenticated: !!session?.userId,
      userId: session?.userId || null,
      displayName: session?.displayName || null,
      avatarUrl: session?.avatarUrl || null,
      providers: getEnabledProviders(),
    });
  });

  // ─── Loading page for container initialization ────────
  router.get('/loading', (_req: Request, res: Response) => {
    res.send(buildLoadingPage());
  });

  router.get('/loading/:agentId', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    res.send(buildLoadingPage(agentId));
  });

  return router;
}

// ─── HTML Templates ─────────────────────────────────────

function buildLoadingPage(agentId?: string): string {
  const agentName = agentId ? `Agent ${agentId}` : 'Your workspace';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AionUi - Preparing</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
      color: #fff;
    }
    .container {
      text-align: center;
      padding: 48px 40px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      min-width: 360px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    .logo {
      font-size: 48px;
      margin-bottom: 24px;
      animation: pulse 2s ease-in-out infinite;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 16px;
      font-weight: 600;
    }
    .subtitle {
      color: rgba(255,255,255,0.6);
      margin-bottom: 32px;
      font-size: 16px;
      line-height: 1.5;
    }
    .loading-container {
      margin: 40px 0;
    }
    .loading-dots {
      display: inline-flex;
      gap: 8px;
    }
    .dot {
      width: 12px;
      height: 12px;
      background: rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      animation: bounce 1.4s infinite ease-in-out both;
    }
    .dot:nth-child(1) { animation-delay: -0.32s; }
    .dot:nth-child(2) { animation-delay: -0.16s; }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    @keyframes bounce {
      0%, 80%, 100% {
        transform: scale(0.8);
        opacity: 0.5;
      }
      40% {
        transform: scale(1);
        opacity: 1;
      }
    }
    .footer {
      margin-top: 32px;
      font-size: 14px;
      color: rgba(255,255,255,0.3);
    }
    .footer a {
      color: #8b5cf6;
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">⚡</div>
    <h1>准备中</h1>
    <p class="subtitle">正在为您启动 ${agentName}<br>请稍候...</p>

    <div class="loading-container">
      <div class="loading-dots">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
    </div>

    <p class="footer" id="status">已等待 <span id="elapsed">0</span>s · Powered by AionUi Gateway</p>
  </div>

  <script>
    const startTime = Date.now();

    function updateElapsed() {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const el = document.getElementById('elapsed');
      if (el) el.textContent = elapsed;
      requestAnimationFrame(updateElapsed);
    }
    updateElapsed();

    // Request main page to trigger container startup (ensureInstance).
    // The request blocks server-side until the container is ready, then resolves.
    fetch('/')
      .then((response) => {
        if (response.status < 500) {
          // Container is ready, redirect to app
          window.location.href = '/';
        } else {
          showError();
        }
      })
      .catch(() => {
        showError();
      });

    function showError() {
      document.querySelector('.subtitle').innerHTML =
        '启动时间较长或遇到问题<br>请<a href="/" style="color: #8b5cf6">点击重试</a>或刷新页面';
    }
  </script>
</body>
</html>`;
}

function getBaseUrl(req: Request): string {
  if (process.env.GATEWAY_BASE_URL) return process.env.GATEWAY_BASE_URL;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`;
  return `${protocol}://${host}`;
}

function buildLoginPage(providers: string[]): string {
  const providerButtons = providers
    .map((p) => {
      const label = p.charAt(0).toUpperCase() + p.slice(1);
      const icon = p === 'github' ? '🐙' : p === 'google' ? '🔍' : p === 'zhimi' ? '🏢' : p === 'feishu' ? '📱' : '🔑';
      const displayLabel = p === 'zhimi' ? 'Zhimi SSO' : p === 'feishu' ? 'Feishu SSO' : label;
      return `<a href="/gateway/oauth/${p}" class="btn btn-${p}">${icon} Sign in with ${displayLabel}</a>`;
    })
    .join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AionUi - Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
      color: #fff;
    }
    .container {
      text-align: center;
      padding: 48px 40px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      min-width: 360px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    .logo { font-size: 36px; margin-bottom: 8px; }
    h1 { font-size: 24px; margin-bottom: 8px; font-weight: 600; }
    .subtitle { color: rgba(255,255,255,0.6); margin-bottom: 32px; font-size: 14px; }
    .btn {
      display: block;
      padding: 14px 24px;
      margin: 12px 0;
      border-radius: 10px;
      text-decoration: none;
      font-size: 15px;
      font-weight: 500;
      transition: all 0.2s ease;
      border: 1px solid rgba(255,255,255,0.15);
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
    .btn-github { background: #24292e; color: #fff; }
    .btn-github:hover { background: #2f363d; }
    .btn-google { background: #fff; color: #333; border-color: #ddd; }
    .btn-google:hover { background: #f5f5f5; }
    .btn-zhimi { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
    .btn-zhimi:hover { opacity: 0.9; }
    .btn-feishu { background: #1f2329; color: #fff; border-color: #334155; }
    .btn-feishu:hover { background: #334155; }
    .footer { margin-top: 24px; font-size: 12px; color: rgba(255,255,255,0.3); }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">⚡</div>
    <h1>AionUi</h1>
    <p class="subtitle">Sign in to access your AI workspace</p>
    <div>
        ${providerButtons || '<p style="color: rgba(255,255,255,0.5)">No OAuth providers configured</p>'}
    </div>
    <p class="footer">Powered by AionUi Gateway</p>
  </div>
</body>
</html>`;
}
