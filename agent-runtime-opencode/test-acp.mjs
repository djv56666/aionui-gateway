/**
 * ACP Bridge 测试脚本
 *
 * 用法: node test-acp.mjs [ws-url]
 * 默认: ws://localhost:3001/acp
 */
import { WebSocket } from 'ws';

const url = process.argv[2] || 'ws://localhost:3001/acp';
let msgId = 0;

function rpc(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params });
}

console.log(`Connecting to ${url} ...`);
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('\n✅ WebSocket connected\n');

  // Step 1: initialize
  console.log('>>> initialize');
  ws.send(rpc('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'test-client', version: '1.0.0' },
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  // Pretty print
  if (msg.method === 'bridge/status') {
    console.log(`<<< bridge/status: ${msg.params.status}`, msg.params.reason || msg.params.message || '');
    return;
  }

  if (msg.id && msg.result !== undefined) {
    console.log(`<<< response (id=${msg.id}):`, JSON.stringify(msg.result, null, 2));
  } else if (msg.id && msg.error) {
    console.log(`<<< error (id=${msg.id}):`, JSON.stringify(msg.error, null, 2));
  } else if (msg.method) {
    // Stream notification — show compact
    const compact = JSON.stringify(msg);
    if (compact.length > 200) {
      console.log(`<<< notification: ${msg.method} ...(${compact.length} bytes)`);
    } else {
      console.log(`<<< notification:`, compact);
    }
  } else {
    console.log(`<<<`, data.toString().substring(0, 300));
  }

  // Step 2: after initialize response → session/new
  if (msg.id === 1 && msg.result) {
    console.log('\n>>> session/new');
    ws.send(rpc('session/new', {
      cwd: '/workspace',
      mcpServers: [],
    }));
  }

  // Step 3: after session/new response → send a prompt
  if (msg.id === 2 && msg.result) {
    const sessionId = msg.result.sessionId || msg.result.id || 'default';
    console.log(`\n>>> session/prompt (sessionId=${sessionId})`);
    ws.send(rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Say "Hello from ACP Bridge!" and nothing else.' }],
    }));
  }

  // Step 4: after prompt completes, close
  // (will close after 15s timeout or when stream ends)
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`\n🔌 WebSocket closed: ${code} ${reason.toString()}`);
  process.exit(0);
});

// Timeout: close after 30s
setTimeout(() => {
  console.log('\n⏰ Timeout (30s), closing...');
  ws.close();
}, 30000);
