import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(root, 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const roomIdPattern = /^[a-f0-9]{12}$/;
const rooms = new Map();
const MAX_BODY = 16 * 1024;
const MAX_FRAME = 1024 * 1024;

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('Corpo da requisição muito grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolveBody(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function isHostToken(room, token) {
  if (typeof token !== 'string' || token.length !== room.hostToken.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(room.hostToken));
}

function send(socket, value) {
  if (socket.websocketState !== 1) return;
  const payload = Buffer.from(JSON.stringify(value));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function closeSocket(socket, code = 1000, reason = '') {
  if (socket.websocketState !== 1) return;
  socket.websocketState = 2;
  const text = Buffer.from(reason).subarray(0, 120);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
  socket.end();
}

function broadcast(room, value, except) {
  if (room.host && room.host !== except) send(room.host, value);
  for (const viewer of room.viewers.values()) {
    if (viewer !== except) send(viewer, value);
  }
}

function closeRoom(room, reason = 'Sala encerrada.') {
  if (!rooms.has(room.id)) return;
  broadcast(room, { type: 'room-closed', message: reason });
  for (const socket of [room.host, ...room.viewers.values()]) {
    if (socket) closeSocket(socket, 1000, reason);
  }
  clearTimeout(room.hostGraceTimer);
  rooms.delete(room.id);
}

function iceServers() {
  const servers = [];
  const stun = process.env.STUN_URL || 'stun:stun.l.google.com:19302';
  for (const url of stun.split(',').map((item) => item.trim()).filter(Boolean)) {
    servers.push({ urls: url });
  }

  const turnUrls = (process.env.TURN_URL || '').split(',').map((item) => item.trim()).filter(Boolean);
  const secret = process.env.TURN_SHARED_SECRET;
  if (turnUrls.length && secret) {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expiry}:brutroom`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    servers.push({ urls: turnUrls, username, credential });
  }
  return servers;
}

async function serveStatic(pathname, res) {
  const fileByPath = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/styles.css', 'styles.css'],
    ['/app.js', 'app.js'],
  ]);
  const filename = fileByPath.get(pathname);
  if (!filename) return false;
  try {
    const body = await readFile(resolve(publicDir, filename));
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    res.writeHead(200, {
      'content-type': types[extname(filename)],
      'cache-control': filename === 'index.html' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
    return true;
  } catch {
    json(res, 500, { error: 'Não foi possível carregar a aplicação.' });
    return true;
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return json(res, 400, { error: 'Endereço inválido.' }); }

  if (req.method === 'GET' && url.pathname === '/api/ice') {
    return json(res, 200, { iceServers: iceServers() });
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    let id;
    do { id = randomBytes(6).toString('hex'); } while (rooms.has(id));
    const room = {
      id,
      hostToken: randomBytes(32).toString('base64url'),
      host: null,
      viewers: new Map(),
      streaming: false,
      createdAt: Date.now(),
      hostGraceTimer: null,
    };
    rooms.set(id, room);
    return json(res, 201, { id, hostToken: room.hostToken });
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{12})$/);
  if (roomMatch && req.method === 'GET') {
    const room = rooms.get(roomMatch[1]);
    return room
      ? json(res, 200, { id: room.id, streaming: room.streaming, hostConnected: Boolean(room.host) })
      : json(res, 404, { error: 'Esta sala não existe ou já foi encerrada.' });
  }

  const closeMatch = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{12})\/close$/);
  if (closeMatch && req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, 400, { error: error.message }); }
    const room = rooms.get(closeMatch[1]);
    if (!room) return json(res, 404, { error: 'Esta sala já foi encerrada.' });
    if (!isHostToken(room, body.hostToken)) return json(res, 403, { error: 'Somente quem criou a sala pode encerrá-la.' });
    closeRoom(room);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && (url.pathname === '/' || /^\/room\/[a-f0-9]{12}$/.test(url.pathname))) {
    if (await serveStatic('/', res)) return;
  }

  if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
  json(res, 404, { error: 'Página não encontrada.' });
});

server.on('upgrade', (req, socket) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { socket.destroy(); return; }
  if (url.pathname !== '/ws' || !req.headers['sec-websocket-key'] || req.headers['sec-websocket-version'] !== '13') {
    socket.destroy();
    return;
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) { socket.destroy(); return; }
    } catch { socket.destroy(); return; }
  }

  const roomId = url.searchParams.get('room') || '';
  const room = rooms.get(roomId);
  if (!roomIdPattern.test(roomId) || !room) { socket.destroy(); return; }

  // RFC 6455 requires SHA-1 over the client key plus the fixed WebSocket GUID.
  const acceptKey = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n'));
  socket.websocketState = 1;
  socket.id = randomUUID();
  socket.role = 'pending';
  socket.room = room;
  socket.buffer = Buffer.alloc(0);
  socket.on('error', () => {});

  function assignRole(role) {
    if (role === 'host') {
      if (room.host) {
        closeSocket(socket, 1008, 'O anfitrião já está conectado.');
        return false;
      }
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
      room.host = socket;
      room.streaming = false;
    } else {
      room.viewers.set(socket.id, socket);
    }
    socket.role = role;
    send(socket, { type: 'joined', role, streaming: room.streaming, hostConnected: Boolean(room.host), id: socket.id });
    if (role === 'host') {
      for (const viewer of room.viewers.values()) send(socket, { type: 'viewer-joined', id: viewer.id });
    } else if (room.host) {
      send(room.host, { type: 'viewer-joined', id: socket.id });
    }
    return true;
  }

  function protocolError() {
    closeSocket(socket, 1002, 'Protocolo inválido.');
  }

  function handleFrame(opcode, payload) {
    if (opcode === 0x8) { closeSocket(socket); return false; }
    if (opcode === 0x9) {
      const header = Buffer.from([0x8a, payload.length]);
      socket.write(Buffer.concat([header, payload]));
      return true;
    }
    if (opcode !== 0x1) { protocolError(); return false; }
    let message;
    try { message = JSON.parse(payload.toString('utf8')); }
    catch { protocolError(); return false; }
    if (!message || typeof message.type !== 'string') { protocolError(); return false; }

    if (socket.role === 'pending') {
      if (message.type === 'authenticate-host' && isHostToken(room, message.token)) return assignRole('host');
      if (message.type === 'join-viewer') return assignRole('viewer');
      closeSocket(socket, 1008, 'Autenticação inválida.');
      return false;
    }

    if (message.type === 'signal') {
      if (typeof message.to !== 'string' || !message.payload || typeof message.payload !== 'object') return true;
      if ((socket.role === 'viewer' && room.host?.id !== message.to) || (socket.role === 'host' && !room.viewers.has(message.to))) return true;
      const target = room.host?.id === message.to ? room.host : room.viewers.get(message.to);
      if (target && target !== socket) send(target, { type: 'signal', from: socket.id, payload: message.payload });
      return true;
    }
    if (socket.role !== 'host') return true;

    if (message.type === 'stream-started') {
      room.streaming = true;
      broadcast(room, { type: 'status', streaming: true, hostConnected: true }, socket);
      for (const viewer of room.viewers.values()) send(socket, { type: 'viewer-joined', id: viewer.id });
    } else if (message.type === 'stream-stopped') {
      room.streaming = false;
      broadcast(room, { type: 'status', streaming: false, hostConnected: true }, socket);
    }
    return true;
  }

  socket.on('data', (chunk) => {
    socket.buffer = Buffer.concat([socket.buffer, chunk]);
    while (socket.buffer.length >= 2) {
      const first = socket.buffer[0];
      const second = socket.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (!masked) { protocolError(); return; }
      if (length === 126) {
        if (socket.buffer.length < 4) return;
        length = socket.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (socket.buffer.length < 10) return;
        const longLength = socket.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_FRAME)) { closeSocket(socket, 1009, 'Mensagem grande demais.'); return; }
        length = Number(longLength);
        offset = 10;
      }
      if (length > MAX_FRAME) { closeSocket(socket, 1009, 'Mensagem grande demais.'); return; }
      if (socket.buffer.length < offset + 4 + length) return;
      const mask = socket.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(socket.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      socket.buffer = socket.buffer.subarray(offset + 4 + length);
      if (!handleFrame(opcode, payload)) return;
    }
  });

  socket.on('close', () => {
    if (!rooms.has(room.id)) return;
    if (socket.role === 'host' && room.host === socket) {
      room.host = null;
      room.streaming = false;
      broadcast(room, { type: 'status', streaming: false, hostConnected: false });
      room.hostGraceTimer = setTimeout(() => closeRoom(room, 'A sala expirou após a desconexão do anfitrião.'), 90_000);
      room.hostGraceTimer.unref();
    } else if (socket.role === 'viewer' && room.viewers.delete(socket.id)) {
      if (room.host) send(room.host, { type: 'viewer-left', id: socket.id });
    }
  });
});

const expirySweep = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > 6 * 60 * 60 * 1000) closeRoom(room, 'A sala expirou.');
  }
}, 60_000);
expirySweep.unref();

server.listen(port, host, () => {
  console.log(`Brutroom disponível em http://localhost:${port}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
