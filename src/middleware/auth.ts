/**
 * Authentication guard middleware.
 * Redirects unauthenticated requests to the login page.
 */

import type { Request, Response, NextFunction } from 'express';

interface AuthenticatedSession {
  userId?: string;
  [key: string]: unknown;
}

/**
 * Middleware that requires authentication.
 * For API requests (Accept: application/json), returns 401.
 * For page requests, redirects to /gateway/login.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = req.session as unknown as AuthenticatedSession | undefined;

  if (session?.userId) {
    next();
    return;
  }

  // API requests get JSON response
  const acceptsJson = req.headers.accept?.includes('application/json');
  if (acceptsJson) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Page requests get redirected to login
  res.redirect('/gateway/login');
}

/**
 * Middleware that only allows unauthenticated requests.
 * If already logged in, redirect to root.
 */
export function guestOnly(req: Request, res: Response, next: NextFunction): void {
  const session = req.session as unknown as AuthenticatedSession | undefined;

  if (session?.userId) {
    res.redirect('/');
    return;
  }

  next();
}
