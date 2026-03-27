/**
 * Reverse proxy middleware — routes authenticated requests to user's AionUi instance.
 *
 * Handles both regular HTTP requests and WebSocket upgrades.
 */

import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { ensureInstance, touchInstance, getInstanceToken } from '../instance/manager.js';

interface AuthenticatedSession {
  userId?: string;
  username?: string;
  displayName?: string;
  [key: string]: unknown;
}

/**
 * Express middleware that resolves the user's AionUi instance port
 * and stores it on the request for the proxy to use.
 *
 * Must run AFTER cookie-session and requireAuth.
 */
async function resolveInstanceMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const session = req.session as unknown as AuthenticatedSession | undefined;
  const userId = session?.userId;

  // Debug: log session state for troubleshooting
  console.log(`[proxy] ${req.method} ${req.path} → userId: ${userId || 'MISSING'}`);

  if (!userId) {
    // Should not happen — requireAuth should have caught this
    console.error(`[proxy] No userId for ${req.method} ${req.originalUrl}, cookies:`, req.headers.cookie?.substring(0, 100));
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const port = await ensureInstance(userId, session?.username);
    touchInstance(userId);
    (req as any).__proxyTarget = `http://127.0.0.1:${port}`;
    (req as any).__aionuiToken = getInstanceToken(userId);
    next();
  } catch (err) {
    console.error(`[proxy] Failed to ensure instance for ${userId}:`, err);
    res.status(502).json({ error: 'Failed to start backend instance' });
  }
}

/**
 * Create the proxy middleware + the instance resolution middleware as a chain.
 */
export function createProxyHandler() {
  const proxy = createProxyMiddleware({
    // Dynamic target from the stashed value
    router: (req: IncomingMessage) => {
      return (req as any).__proxyTarget || 'http://127.0.0.1:4001';
    },

    // WebSocket support
    ws: true,

    // Don't change the origin — AionUi checks localhost
    changeOrigin: false,

    // Forward cookies (AionUi's own session cookie)
    cookieDomainRewrite: '',

    // Error handling
    on: {
      error(err, _req, res) {
        console.error('[proxy] Error:', err.message);
        if (res && 'writeHead' in res && !res.headersSent) {
          (res as Response).status(502).json({
            error: 'Backend instance unavailable',
            message: err.message,
          });
        }
      },
      proxyReq(proxyReq, req) {
        const cookies = proxyReq.getHeader('cookie') as string | undefined;
        let filtered = '';
        if (cookies) {
          filtered = cookies
            .split(';')
            .filter((c) => !c.trim().startsWith('gateway-session'))
            .join(';')
            .trim();
        }

        const token = (req as any).__aionuiToken as string | undefined;
        if (token) {
          filtered = filtered ? `${filtered}; aionui-session=${token}` : `aionui-session=${token}`;
        }

        if (filtered) {
          proxyReq.setHeader('cookie', filtered);
        } else {
          proxyReq.removeHeader('cookie');
        }
      },
    },

    // Don't log every request
    logger: undefined,
  } satisfies Options);

  // Return both middleware as a chain: resolve instance first, then proxy
  return [resolveInstanceMiddleware, proxy] as const;
}

/**
 * WebSocket upgrade handler for the HTTP server.
 * Must be attached to server.on('upgrade', ...) separately.
 *
 * WebSocket upgrades don't go through Express middleware, so we need
 * to manually parse the gateway session cookie to find the userId.
 * cookie-session stores data as base64(JSON.stringify(sessionData)).
 */
export function createWsUpgradeHandler() {
  return async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const cookieHeader = req.headers.cookie || '';

    // cookie-session sets two cookies: gateway-session and gateway-session.sig
    // The session data is base64-encoded JSON in the first cookie
    const match = cookieHeader.match(/gateway-session=([^;]+)/);
    if (!match) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      // cookie-session uses base64 encoding (may have URL-safe chars)
      const raw = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const sessionData = JSON.parse(
        Buffer.from(raw, 'base64').toString('utf-8'),
      ) as AuthenticatedSession;

      if (!sessionData.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const port = await ensureInstance(sessionData.userId, sessionData.username);
      touchInstance(sessionData.userId);

      const token = getInstanceToken(sessionData.userId);
      if (token) {
        const existingCookies = req.headers.cookie || '';
        req.headers.cookie = existingCookies
          ? `${existingCookies}; aionui-session=${token}`
          : `aionui-session=${token}`;
      }

      // Create a one-off proxy for this WebSocket upgrade
      const proxy = createProxyMiddleware({
        target: `http://127.0.0.1:${port}`,
        ws: true,
        changeOrigin: false,
      });

      // Trigger the upgrade
      proxy.upgrade!(req, socket, head);
    } catch (err) {
      console.error('[proxy] WebSocket upgrade error:', err);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  };
}
