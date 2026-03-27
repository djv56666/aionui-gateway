/**
 * AionUi Gateway — Entry point.
 *
 * Provides OAuth2 authentication and reverse-proxies authenticated users
 * to their dedicated AionUi server instances.
 */

import 'dotenv/config';

import express from 'express';
import { createServer } from 'node:http';
import cookieSession from 'cookie-session';
import helmet from 'helmet';
import { config } from './config/index.js';
import { createGatewayRouter } from './routes/gateway.js';
import { createProxyHandler, createWsUpgradeHandler } from './proxy/index.js';
import { requireAuth } from './middleware/auth.js';
import { startIdleReaper, shutdownAll } from './instance/manager.js';
import { closeDb } from './database/index.js';

const app = express();
const server = createServer(app);

// ─── Security ─────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: false, // AionUi manages its own CSP
  }),
);

// ─── Session ──────────────────────────────────────────

app.use(
  cookieSession({
    name: 'gateway-session',
    keys: [config.sessionSecret],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  }),
);

// ─── Gateway routes (login/logout/OAuth callbacks) ────

app.use('/gateway', createGatewayRouter());

// ─── Health check ─────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── All other routes → proxy to user's AionUi instance

const [resolveInstance, proxyMiddleware] = createProxyHandler();
app.use(requireAuth, resolveInstance, proxyMiddleware);

// ─── WebSocket upgrade handler ────────────────────────

server.on('upgrade', createWsUpgradeHandler());

// ─── Start ────────────────────────────────────────────

server.listen(config.port, () => {
  console.log('\n' + '='.repeat(60));
  console.log('⚡ AionUi Gateway started');
  console.log('='.repeat(60));
  console.log(`   URL:          http://localhost:${config.port}`);
  console.log(`   Login page:   http://localhost:${config.port}/gateway/login`);
  console.log(`   Providers:    ${getProviderSummary()}`);
  console.log(`   Data root:    ${config.instanceDataRoot}`);
  console.log(`   Port range:   ${config.instancePortStart}-${config.instancePortEnd}`);
  console.log(`   Idle timeout: ${config.instanceIdleTimeout / 1000}s`);
  console.log('='.repeat(60) + '\n');

  // Start the idle instance reaper
  startIdleReaper();
});

// ─── Graceful shutdown ────────────────────────────────

let isShuttingDown = false;

function shutdown(signal: string): void {
  if (isShuttingDown) {
    console.log(`[gateway] Received second ${signal}, forcing exit...`);
    process.exit(1);
  }
  isShuttingDown = true;
  console.log(`\n[gateway] Received ${signal}, shutting down...`);

  // Kill all user instances
  shutdownAll();

  // Close Gateway DB
  closeDb();

  // Close HTTP server
  server.close(() => {
    console.log('[gateway] Server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('[gateway] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('exit', () => {
  closeDb();
});

// ─── Helpers ──────────────────────────────────────────

function getProviderSummary(): string {
  const providers: string[] = [];
  if (config.oauth.zhimi.enabled) providers.push('Zhimi SSO ✅');
  else providers.push('Zhimi SSO ❌');
  if (config.oauth.github.enabled) providers.push('GitHub ✅');
  else providers.push('GitHub ❌');
  if (config.oauth.google.enabled) providers.push('Google ✅');
  else providers.push('Google ❌');
  return providers.join(', ');
}
