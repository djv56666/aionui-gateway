export type OAuthProvider = 'github' | 'google' | 'zhimi' | 'feishu';

export interface GatewayUser {
  id: string;
  oauthProvider: OAuthProvider;
  oauthId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  email: string | null;
  createdAt: number;
  lastLogin: number;
}

export interface UserInstance {
  userId: string;
  port: number;
  pid: number;
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  lastActive: number;
  startedAt: number;
  restartCount: number;
}
