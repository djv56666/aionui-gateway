import type { Request } from 'express';
import { config } from '../config/index.js';

export function getBaseUrl(req: Request): string {
  if (process.env.GATEWAY_BASE_URL) return process.env.GATEWAY_BASE_URL;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`;
  return `${protocol}://${host}`;
}