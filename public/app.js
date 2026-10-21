const home = document.querySelector('#home');
const roomView = document.querySelector('#room');
const createButton = document.querySelector('#create-room');
const joinForm = document.querySelector('#join-form');
const roomCodeInput = document.querySelector('#room-code');
const homeError = document.querySelector('#home-error');
const roomError = document.querySelector('#room-error');
const headerState = document.querySelector('#header-state');
const headerStateText = document.querySelector('#header-state-text');
const stage = document.querySelector('.stage');
const stageTitle = document.querySelector('#stage-title');
const stageDescription = document.querySelector('#stage-description');
const stageStatus = document.querySelector('#stage-status');
const connectionCopy = document.querySelector('#connection-copy');
const roleLabel = document.querySelector('#role-label');
const video = document.querySelector('#screen-video');
const toast = document.querySelector('#toast');

let currentRoom = null;
let isHost = false;
let socket = null;
let screenStream = null;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let roomWasClosed = false;
const peers = new Map();
const pendingCandidates = new Map();
let toastTimer;

function setError(element, message = '') {
  element.textContent = message;
  element.classList.toggle('hidden', !message);
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir esta ação.');
  return data;
}

function roomUrl(id) { return `${location.origin}/room/${id}`; }

function parseRoomInput(value) {
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    const match = url.pathname.match(/^\/room\/([a-f0-9]{12})\/?$/i);
    if (match) return match[1].toLowerCase();
  } catch {}
  const code = text.match(/^(?:room\/)?([a-f0-9]{12})$/i);
  return code ? code[1].toLowerCase() : null;
}

function showHome() {
  home.classList.remove('hidden');
  roomView.classList.add('hidden');
  headerState.classList.add('hidden');
  history.pushState({}, '', '/');
  currentRoom = null;
}

function showRoom(id, host) {
  currentRoom = id;
  isHost = host;
  roomWasClosed = false;
  home.classList.add('hidden');
  roomView.classList.remove('hidden');
  headerState.classList.remove('hidden');
  history.pushState({}, '', `/room/${id}`);
  document.querySelector('#room-title').textContent = `Sala ${id.slice(0, 6)}`;
  document.querySelector('#stage-room-code').textContent = id.toUpperCase();
  roleLabel.textContent = host ? 'ANFITRIÃO' : 'ESPECTADOR';
  document.querySelector('#share-screen').classList.toggle('hidden', !host);
  document.querySelector('#close-room').classList.toggle('hidden', !host);
  document.querySelector('#leave-room').classList.toggle('hidden', host);
  document.querySelector('#stop-screen').classList.add('hidden');
  video.srcObject = null;
  stage.classList.remove('has-video', 'is-live');
  stageTitle.textContent = host ? 'Sua sala está pronta' : 'Aguardando o início';
  stageDescription.textContent = host
    ? 'Envie o convite e compartilhe sua tela quando estiver pronto.'
    : 'A transmissão aparecerá aqui quando o anfitrião compartilhar a tela.';
  stageStatus.textContent = 'Conectando à sala';
  connectionCopy.textContent = 'Estabelecendo conexão segura';
  setError(roomError);
  connectToRoom(id, host);
}

function setConnection(streaming, hostConnected = true) {
  const live = streaming && hostConnected;
  headerState.classList.toggle('is-live', live);
  headerStateText.textContent = live ? 'Transmitindo' : hostConnected ? 'Aguardando transmissão' : 'Anfitrião desconectado';
  stage.classList.toggle('is-live', live);
  stageStatus.textContent = live ? 'Transmissão ao vivo' : hostConnected ? 'Aguardando transmissão' : 'Anfitrião desconectado';
  connectionCopy.textContent = live ? 'Conexão ativa' : hostConnected ? 'Sala conectada' : 'Reconectando à sala';
  if (!live && !isHost) {
    closePeers();
    video.srcObject = null;
    stage.classList.remove('has-video');
    stageTitle.textContent = hostConnected ? 'Aguardando o início' : 'Anfitrião desconectado';
    stageDescription.textContent = hostConnected
      ? 'A transmissão aparecerá aqui quando o anfitrião compartilhar a tela.'
      : 'A sala será encerrada se o anfitrião não voltar em breve.';
  }
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connectToRoom(id, host) {
  const token = host ? sessionStorage.getItem(`brutroom-host:${id}`) : '';
  const params = new URLSearchParams({ room: id });
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}/ws?${params}`);
  socket.addEventListener('open', () => {
    send(host && token ? { type: 'authenticate-host', token } : { type: 'join-viewer' });
    headerStateText.textContent = 'Conectada';
    connectionCopy.textContent = 'Sala conectada';
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleMessage(message);
  });
  socket.addEventListener('close', () => {
    if (currentRoom !== id) return;
    if (isHost && screenStream) stopSharing(false);
    if (roomWasClosed) return;
    setConnection(false, false);
    if (!roomError.textContent) setError(roomError, 'A conexão com a sala foi encerrada.');
  });
  socket.addEventListener('error', () => {
    if (currentRoom === id) setError(roomError, 'Não foi possível conectar ao servidor da sala.');
  });
}

function closePeers() {
  for (const pc of peers.values()) pc.close();
  peers.clear();
  pendingCandidates.clear();
}

function makePeer(id) {
  if (peers.has(id) || !screenStream) return;
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(id, pc);
  for (const track of screenStream.getTracks()) pc.addTrack(track, screenStream);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'signal', to: id, payload: { type: 'candidate', candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') setError(roomError, 'A conexão de vídeo falhou. Verifique a configuração STUN/TURN.');
  };
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => send({ type: 'signal', to: id, payload: { type: 'offer', description: pc.localDescription } }))
    .catch(() => setError(roomError, 'Não foi possível iniciar a transmissão para um espectador.'));
}

async function applySignal(message) {
  const { from, payload } = message;
  if (!from || !payload) return;
  if (isHost) {
    const pc = peers.get(from);
    if (!pc) return;
    if (payload.type === 'answer' && payload.description) {
      await pc.setRemoteDescription(payload.description);
      for (const candidate of pendingCandidates.get(from) || []) await pc.addIceCandidate(candidate);
      pendingCandidates.delete(from);
    } else if (payload.type === 'candidate' && payload.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
      else pendingCandidates.set(from, [...(pendingCandidates.get(from) || []), payload.candidate]);
    }
    return;
  }

  if (payload.type === 'offer' && payload.description) {
    closePeers();
    const pc = new RTCPeerConnection({ iceServers });
    peers.set(from, pc);
    pc.ontrack = ({ streams }) => {
      video.srcObject = streams[0];
      stage.classList.add('has-video');
      stageTitle.textContent = 'Transmissão ao vivo';
      setError(roomError);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ type: 'signal', to: from, payload: { type: 'candidate', candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') setError(roomError, 'A conexão de vídeo falhou. Verifique a rede ou o servidor TURN.');
    };
    await pc.setRemoteDescription(payload.description);
    for (const candidate of pendingCandidates.get(from) || []) await pc.addIceCandidate(candidate);
    pendingCandidates.delete(from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'signal', to: from, payload: { type: 'answer', description: pc.localDescription } });
  } else if (payload.type === 'candidate' && payload.candidate) {
    const pc = peers.get(from);
    if (pc?.remoteDescription) await pc.addIceCandidate(payload.candidate);
    else pendingCandidates.set(from, [...(pendingCandidates.get(from) || []), payload.candidate]);
  }
}

function handleMessage(message) {
  switch (message.type) {
    case 'joined':
      if (message.role !== (isHost ? 'host' : 'viewer')) {
        setError(roomError, 'Não foi possível confirmar seu papel nesta sala. Volte ao início e entre novamente.');
        socket?.close();
        return;
      }
      setConnection(Boolean(message.streaming), Boolean(message.hostConnected));
      break;
    case 'viewer-joined':
      makePeer(message.id);
      break;
    case 'viewer-left': {
      peers.get(message.id)?.close();
      peers.delete(message.id);
      pendingCandidates.delete(message.id);
      break;
    }
    case 'signal':
      applySignal(message).catch(() => setError(roomError, 'Não foi possível negociar a conexão de vídeo.'));
      break;
    case 'status':
      setConnection(Boolean(message.streaming), Boolean(message.hostConnected));
      if (message.streaming) setError(roomError);
      break;
    case 'room-closed':
      roomWasClosed = true;
      closePeers();
      if (screenStream) stopSharing(false);
      headerState.classList.remove('is-live');
      headerStateText.textContent = 'Sala encerrada';
      stage.classList.remove('is-live');
      stageStatus.textContent = 'Sala encerrada';
      connectionCopy.textContent = 'Sessão finalizada';
      stageTitle.textContent = 'Sala encerrada';
      stageDescription.textContent = 'Esta transmissão e o convite não estão mais disponíveis.';
      video.srcObject = null;
      stage.classList.remove('has-video');
      setError(roomError, message.message || 'Esta sala foi encerrada.');
      break;
  }
}

async function fetchIceServers() {
  try {
    const data = await request('/api/ice');
    if (Array.isArray(data.iceServers)) iceServers = data.iceServers;
  } catch {
    // STUN público padrão mantém a sala utilizável em redes compatíveis.
  }
}

async function createRoom() {
  setError(homeError);
  createButton.disabled = true;
  createButton.querySelector('span').textContent = 'Criando sala…';
  try {
    const room = await request('/api/rooms', { method: 'POST', body: '{}' });
    sessionStorage.setItem(`brutroom-host:${room.id}`, room.hostToken);
    showRoom(room.id, true);
  } catch (error) {
    setError(homeError, error.message);
  } finally {
    createButton.disabled = false;
    createButton.querySelector('span').textContent = 'Criar uma sala';
  }
}

async function joinRoom(value) {
  setError(homeError);
  const id = parseRoomInput(value);
  if (!id) return setError(homeError, 'Informe um link ou código de sala válido.');
  try {
    const room = await request(`/api/rooms/${id}`);
    const host = Boolean(sessionStorage.getItem(`brutroom-host:${id}`));
    showRoom(room.id, host);
  } catch (error) {
    setError(homeError, error.message);
  }
}

async function startSharing() {
  setError(roomError);
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return setError(roomError, 'Este navegador não permite compartilhar a tela neste endereço. Use HTTPS ou localhost em uma versão recente do navegador.');
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    screenStream.getVideoTracks()[0].addEventListener('ended', () => stopSharing(true), { once: true });
    send({ type: 'stream-started' });
    video.srcObject = screenStream;
    stage.classList.add('has-video');
    document.querySelector('#share-screen').classList.add('hidden');
    document.querySelector('#stop-screen').classList.remove('hidden');
    stageTitle.textContent = 'Sua tela está sendo compartilhada';
    stageDescription.textContent = 'A transmissão está disponível para quem entrar nesta sala.';
    setConnection(true, true);
  } catch (error) {
    if (error.name === 'NotAllowedError') setError(roomError, 'O compartilhamento foi cancelado. Você pode tentar novamente quando quiser.');
    else setError(roomError, 'Não foi possível iniciar o compartilhamento da tela.');
  }
}

function stopSharing(notifyServer = true) {
  if (!screenStream) return;
  const stream = screenStream;
  screenStream = null;
  for (const track of stream.getTracks()) track.stop();
  video.srcObject = null;
  stage.classList.remove('has-video');
  closePeers();
  if (notifyServer) send({ type: 'stream-stopped' });
  document.querySelector('#stop-screen').classList.add('hidden');
  document.querySelector('#share-screen').classList.remove('hidden');
  if (isHost && currentRoom) {
    stageTitle.textContent = 'Sua sala está pronta';
    stageDescription.textContent = 'Envie o convite e compartilhe sua tela quando estiver pronto.';
    setConnection(false, true);
  }
}

async function closeCurrentRoom() {
  const token = sessionStorage.getItem(`brutroom-host:${currentRoom}`);
  if (screenStream) stopSharing(false);
  try {
    await request(`/api/rooms/${currentRoom}/close`, { method: 'POST', body: JSON.stringify({ hostToken: token }) });
  } catch (error) {
    setError(roomError, error.message);
    return;
  }
  sessionStorage.removeItem(`brutroom-host:${currentRoom}`);
  socket?.close();
  closePeers();
  showHome();
  notify('Sala encerrada.');
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(roomUrl(currentRoom));
    notify('Link copiado.');
  } catch {
    const field = document.createElement('textarea');
    field.value = roomUrl(currentRoom);
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    notify(copied ? 'Link copiado.' : 'Não foi possível copiar o link.');
  }
}

createButton.addEventListener('click', createRoom);
joinForm.addEventListener('submit', (event) => { event.preventDefault(); joinRoom(roomCodeInput.value); });
document.querySelector('#share-screen').addEventListener('click', startSharing);
document.querySelector('#stop-screen').addEventListener('click', () => stopSharing(true));
document.querySelector('#copy-invite').addEventListener('click', copyInvite);
document.querySelector('#close-room').addEventListener('click', closeCurrentRoom);
document.querySelector('#leave-room').addEventListener('click', () => { socket?.close(); closePeers(); showHome(); });
document.querySelector('.brand').addEventListener('click', (event) => {
  if (currentRoom) { event.preventDefault(); if (screenStream) stopSharing(true); socket?.close(); closePeers(); showHome(); }
});
window.addEventListener('popstate', () => {
  const match = location.pathname.match(/^\/room\/([a-f0-9]{12})$/i);
  if (!match) {
    if (currentRoom) { if (screenStream) stopSharing(true); socket?.close(); closePeers(); showHome(); }
    else { home.classList.remove('hidden'); roomView.classList.add('hidden'); }
    return;
  }
  if (currentRoom === match[1]) return;
  request(`/api/rooms/${match[1]}`)
    .then((room) => showRoom(room.id, Boolean(sessionStorage.getItem(`brutroom-host:${room.id}`))))
    .catch((error) => { showHome(); setError(homeError, error.message); });
});

window.addEventListener('beforeunload', () => {
  if (screenStream) stopSharing(true);
  socket?.close();
});

fetchIceServers();
const directRoom = location.pathname.match(/^\/room\/([a-f0-9]{12})$/i);
if (directRoom) joinRoom(directRoom[1]);
