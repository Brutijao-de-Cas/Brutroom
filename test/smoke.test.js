import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
let processServer;
let baseUrl;

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitUntilReady() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/ice`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError || new Error('O servidor não iniciou a tempo.');
}

function createPeer(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else messages.push(message);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Falha ao abrir WebSocket.')), { once: true });
  });
  return {
    ws,
    opened,
    waitFor(predicate, label = 'mensagem WebSocket', timeoutMs = 3000) {
      const cached = messages.findIndex(predicate);
      if (cached >= 0) return Promise.resolve(messages.splice(cached, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Tempo esgotado aguardando ${label}.`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    send(value) { ws.send(JSON.stringify(value)); },
  };
}

before(async () => {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  processServer = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      STUN_URL: 'stun:stun.test.invalid:3478',
      TURN_URL: 'turn:turn.test.invalid:3478',
      TURN_SHARED_SECRET: 'smoke-test-secret',
    },
    stdio: 'ignore',
  });
  await waitUntilReady();
});

after(() => processServer?.kill('SIGTERM'));

test('salas, ICE, papéis, sinalização WebSocket e encerramento', async (t) => {
  const iceResponse = await fetch(`${baseUrl}/api/ice`);
  const ice = await iceResponse.json();
  assert.equal(ice.iceServers.length, 2);
  assert.equal(ice.iceServers[0].urls, 'stun:stun.test.invalid:3478');
  assert.ok(ice.iceServers[1].username);
  assert.ok(ice.iceServers[1].credential);

  const createResponse = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
  assert.equal(createResponse.status, 201);
  const room = await createResponse.json();
  assert.match(room.id, /^[a-f0-9]{12}$/);
  assert.ok(room.hostToken);
  assert.equal((await fetch(`${baseUrl}/api/rooms/${room.id}`)).status, 200);

  const closeUrl = `${baseUrl}/api/rooms/${room.id}/close`;
  const denied = await fetch(closeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostToken: 'wrong' }) });
  assert.equal(denied.status, 403);

  const wsBase = baseUrl.replace('http:', 'ws:');
  const host = createPeer(`${wsBase}/ws?room=${room.id}`);
  const hostJoined = host.waitFor((message) => message.type === 'joined', 'entrada do anfitrião');
  await host.opened;
  host.send({ type: 'authenticate-host', token: room.hostToken });
  const hostState = await hostJoined;
  assert.equal(hostState.role, 'host');

  const viewerJoined = host.waitFor((message) => message.type === 'viewer-joined', 'entrada do espectador');
  const viewer = createPeer(`${wsBase}/ws?room=${room.id}`);
  const viewerStatePromise = viewer.waitFor((message) => message.type === 'joined', 'entrada do espectador');
  await viewer.opened;
  viewer.send({ type: 'join-viewer' });
  const viewerState = await viewerStatePromise;
  const viewerOnHost = await viewerJoined;
  assert.equal(viewerState.role, 'viewer');
  assert.equal(viewerState.hostConnected, true);

  const liveState = viewer.waitFor((message) => message.type === 'status' && message.streaming, 'início da transmissão');
  host.send({ type: 'stream-started' });
  await liveState;

  const stoppedState = viewer.waitFor((message) => message.type === 'status' && !message.streaming, 'fim da transmissão');
  host.send({ type: 'stream-stopped' });
  await stoppedState;

  const relayToViewer = viewer.waitFor((message) => message.type === 'signal', 'sinalização para o espectador');
  host.send({ type: 'signal', to: viewerOnHost.id, payload: { type: 'offer', description: { sdp: 'test-sdp', type: 'offer' } } });
  assert.equal((await relayToViewer).payload.type, 'offer');

  const relayToHost = host.waitFor((message) => message.type === 'signal', 'sinalização para o anfitrião');
  viewer.send({ type: 'signal', to: hostState.id, payload: { type: 'answer', description: { sdp: 'test-sdp', type: 'answer' } } });
  assert.equal((await relayToHost).payload.type, 'answer');

  const roomClosed = viewer.waitFor((message) => message.type === 'room-closed', 'encerramento da sala');
  const closed = await fetch(closeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostToken: room.hostToken }) });
  assert.equal(closed.status, 200);
  assert.equal((await roomClosed).type, 'room-closed');
  assert.equal((await fetch(`${baseUrl}/api/rooms/${room.id}`)).status, 404);
  const expiredLink = await fetch(`${baseUrl}/room/${room.id}`);
  assert.equal(expiredLink.status, 200);
  assert.match(expiredLink.headers.get('content-type'), /text\/html/);

  t.after(() => { host.ws.close(); viewer.ws.close(); });
});
