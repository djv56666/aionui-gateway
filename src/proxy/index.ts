/**
 * Reverse proxy middleware — routes authenticated requests to user's AionUi instance.
 *
 * Handles both regular HTTP requests and WebSocket upgrades.
 */

import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import http from 'node:http';
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

  if (!userId) {
    console.error(`[proxy] No userId for ${req.method} ${req.originalUrl}`);
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
 * Strip gateway-session cookies and inject the AionUI token into
 * the cookie header string. Used by both HTTP and WebSocket paths.
 */
function rewriteCookies(originalCookies: string | undefined, token: string | null): string {
  let filtered = '';
  if (originalCookies) {
    filtered = originalCookies
      .split(';')
      .filter((c) => {
        const name = c.trim().split('=')[0];
        return name !== 'gateway-session' && name !== 'gateway-session.sig' && name !== 'aionui-session';
      })
      .join(';')
      .trim();
  }

  if (token) {
    filtered = filtered ? `${filtered}; aionui-session=${token}` : `aionui-session=${token}`;
  }

  return filtered;
}

/**
 * Create the proxy middleware + the instance resolution middleware as a chain.
 */
export function createProxyHandler() {
  const proxy = createProxyMiddleware({
    router: (req: IncomingMessage) => {
      return (req as any).__proxyTarget || 'http://127.0.0.1:4001';
    },

    // ws: false — WebSocket upgrades are handled separately by createWsUpgradeHandler()
    // which is registered via server.on('upgrade', ...). Having ws:true here would cause
    // http-proxy-middleware to ALSO intercept upgrade requests, resulting in duplicate
    // WebSocket connections to the AionUI container (2x connected → immediate disconnect).
    ws: false,
    changeOrigin: true,
    cookieDomainRewrite: '',

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
        const token = (req as any).__aionuiToken as string | undefined;
        const target = (req as any).__proxyTarget as string | undefined;

        const rewritten = rewriteCookies(cookies, token || null);
        if (rewritten) {
          proxyReq.setHeader('cookie', rewritten);
        } else {
          proxyReq.removeHeader('cookie');
        }

        if (token) {
          proxyReq.setHeader('Authorization', `Bearer ${token}`);
        }

        if (target) {
          proxyReq.setHeader('origin', target);
        }
      },
      proxyRes(proxyRes, req) {
        const token = (req as any).__aionuiToken as string | undefined;
        if (token) {
          const upstream = proxyRes.headers['set-cookie'] || [];
          const arr = Array.isArray(upstream) ? [...upstream] : [upstream];
          const filtered = arr.filter(
            (c) => typeof c === 'string' && !c.startsWith('aionui-session=')
          );
          filtered.push(`aionui-session=${token}; Path=/; HttpOnly; SameSite=Lax`);
          proxyRes.headers['set-cookie'] = filtered;
        }
      },
    },

    logger: undefined,
  } satisfies Options);

  return [resolveInstanceMiddleware, proxy] as const;
}

/**
 * WebSocket upgrade handler for the HTTP server.
 *
 * Uses raw Node.js HTTP to perform the upgrade handshake instead of
 * http-proxy-middleware, which has known issues with WebSocket proxying
 * (race conditions, premature socket close, etc.).
 *
 * The approach: forward the raw upgrade request to the AionUI container
 * and pipe the two sockets together once both sides agree on the upgrade.
 */
export function createWsUpgradeHandler() {
  return async (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const cookieHeader = req.headers.cookie || '';

    const match = cookieHeader.match(/gateway-session=([^;]+)/);
    if (!match) {
      clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    try {
      const raw = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const sessionData = JSON.parse(
        Buffer.from(raw, 'base64').toString('utf-8'),
      ) as AuthenticatedSession;

      if (!sessionData.userId) {
        clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const port = await ensureInstance(sessionData.userId, sessionData.username);
      touchInstance(sessionData.userId);

      const token = getInstanceToken(sessionData.userId);
      const rewrittenCookie = rewriteCookies(req.headers.cookie, token);

      // Build headers for the upstream request, copying everything relevant
      // from the original browser request but rewriting auth-related ones.
      const upstreamHeaders: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        // Skip hop-by-hop headers that we'll set ourselves
        if (key === 'host' || key === 'cookie' || key === 'origin' || key === 'authorization') continue;
        upstreamHeaders[key] = value;
      }

      upstreamHeaders['host'] = `127.0.0.1:${port}`;
      upstreamHeaders['origin'] = `http://127.0.0.1:${port}`;
      upstreamHeaders['cookie'] = rewrittenCookie || undefined;
      if (token) {
        upstreamHeaders['authorization'] = `Bearer ${token}`;
      }

      console.log(`[ws] Upgrade → 127.0.0.1:${port}, token=${token ? 'YES' : 'NULL'}`);

      // Make the upgrade request to the AionUI container
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: req.url || '/',
        method: 'GET',
        headers: upstreamHeaders,
      });

      proxyReq.on('upgrade', (_proxyRes, proxySocket, proxyHead) => {
        // Write the 101 response back to the client, reconstructing it from
        // the upstream's raw response.
        // The 'upgrade' event fires after the upstream sends "101 Switching Protocols".
        // _proxyRes contains the response headers.

        // Build raw HTTP 101 response to send to the browser
        let responseHead = 'HTTP/1.1 101 Switching Protocols\r\n';
        const resHeaders = _proxyRes.headers;
        for (const [key, value] of Object.entries(resHeaders)) {
          if (value === undefined) continue;
          const values = Array.isArray(value) ? value : [value];
          for (const v of values) {
            responseHead += `${key}: ${v}\r\n`;
          }
        }
        responseHead += '\r\n';

        clientSocket.write(responseHead);

        // If there's any buffered data from the upstream, send it
        if (proxyHead && proxyHead.length > 0) {
          clientSocket.write(proxyHead);
        }
        // If there's any buffered data from the client, send it
        if (head && head.length > 0) {
          proxySocket.write(head);
        }

        // Pipe the two sockets together — this is the WebSocket tunnel
        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);

        proxySocket.on('error', (err) => {
          console.error('[ws] Upstream socket error:', err.message);
          clientSocket.destroy();
        });

        clientSocket.on('error', (err) => {
          console.error('[ws] Client socket error:', err.message);
          proxySocket.destroy();
        });

        proxySocket.on('close', () => {
          clientSocket.destroy();
        });

        clientSocket.on('close', () => {
          proxySocket.destroy();
        });
      });

      proxyReq.on('response', (res) => {
        // The upstream did NOT upgrade — it returned a normal HTTP response.
        // Forward it to the client and close.
        console.warn(`[ws] Upstream refused upgrade, status=${res.statusCode}`);
        const statusLine = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
        let headers = '';
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          const values = Array.isArray(value) ? value : [value];
          for (const v of values) {
            headers += `${key}: ${v}\r\n`;
          }
        }
        clientSocket.write(statusLine + headers + '\r\n');
        res.pipe(clientSocket);
      });

      proxyReq.on('error', (err) => {
        console.error('[ws] Proxy request error:', err.message);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
      });

      proxyReq.end();

    } catch (err) {
      console.error('[ws] WebSocket upgrade error:', err);
      clientSocket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      clientSocket.destroy();
    }
  };
}
