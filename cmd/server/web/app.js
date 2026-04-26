(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    ws: null,
    canvas: $('board'),
    ctx: null,
    drawing: false,
    last: null,
    me: { name: '', color: pickColor() },
    cursors: new Map(),
    pendingCursor: null,
    cursorTimer: 0,
    selfId: null,
  };

  function pickColor() {
    const palette = ['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316'];
    return palette[Math.floor(Math.random() * palette.length)];
  }

  function init() {
    state.ctx = state.canvas.getContext('2d');
    sizeCanvas();
    addEventListener('resize', sizeCanvas);

    const params = new URLSearchParams(location.search);
    const presetRoom = params.get('room');
    if (presetRoom) $('room').value = presetRoom;

    const dialog = $('join');
    dialog.showModal();
    dialog.addEventListener('close', () => {
      const room = $('room').value.trim();
      const name = $('name').value.trim() || 'anon';
      state.me.name = name;
      $('roomLabel').textContent = `room: ${room}`;
      connect(room, name);
    });

    state.canvas.addEventListener('mousedown', onDown);
    state.canvas.addEventListener('mousemove', onMove);
    addEventListener('mouseup', onUp);
    state.canvas.addEventListener('mouseleave', onUp);

    $('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('chatInput').value.trim();
      if (!text) return;
      send('chat', { text });
      addMessage(state.me.name, text, state.me.color);
      $('chatInput').value = '';
    });

    requestAnimationFrame(paintLoop);
  }

  function sizeCanvas() {
    const dpr = devicePixelRatio || 1;
    const rect = state.canvas.getBoundingClientRect();
    state.canvas.width = rect.width * dpr;
    state.canvas.height = rect.height * dpr;
    state.ctx.scale(dpr, dpr);
  }

  function connect(room, name) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}&color=${encodeURIComponent(state.me.color)}`;
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => setStatus(true);
    ws.onclose = () => {
      setStatus(false);
      setTimeout(() => connect(room, name), 1500);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = onMessage;
  }

  function setStatus(connected) {
    const el = $('status');
    el.textContent = connected ? 'live' : 'offline';
    el.className = `status ${connected ? 'connected' : 'disconnected'}`;
  }

  function send(type, data) {
    if (!state.ws || state.ws.readyState !== 1) return;
    state.ws.send(JSON.stringify({ type, data }));
  }

  function onMessage(ev) {
    let env;
    try { env = JSON.parse(ev.data); } catch { return; }
    switch (env.type) {
      case 'stroke':
        drawStroke(env.data, false);
        break;
      case 'cursor':
        state.cursors.set(env.from, { ...env.data, last: performance.now(), name: nameFor(env.from), color: colorFor(env.from) });
        break;
      case 'chat':
        addMessage(nameFor(env.from), env.data.text, colorFor(env.from));
        break;
      case 'presence':
        renderPresence(env.data.users);
        break;
    }
  }

  let presence = [];
  function renderPresence(users) {
    presence = users || [];
    const ul = $('presence');
    ul.replaceChildren();
    for (const u of presence) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = u.color;
      li.append(dot, document.createTextNode(u.name));
      ul.append(li);
    }
  }
  function nameFor(id) { return (presence.find((u) => u.id === id) || {}).name || '…'; }
  function colorFor(id) { return (presence.find((u) => u.id === id) || {}).color || '#888'; }

  function addMessage(name, text, color) {
    const div = document.createElement('div');
    div.className = 'msg';
    const b = document.createElement('b');
    b.textContent = name;
    b.style.color = color;
    div.append(b, document.createTextNode(text));
    const box = $('messages');
    box.append(div);
    box.scrollTop = box.scrollHeight;
  }

  function onDown(e) {
    state.drawing = true;
    state.last = canvasPos(e);
  }
  function onMove(e) {
    const p = canvasPos(e);
    queueCursor(p);
    if (state.drawing && state.last) {
      const stroke = { x1: state.last.x, y1: state.last.y, x2: p.x, y2: p.y, color: state.me.color, width: 2 };
      drawStroke(stroke, true);
      send('stroke', stroke);
      state.last = p;
    }
  }
  function onUp() { state.drawing = false; state.last = null; }

  function canvasPos(e) {
    const rect = state.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function drawStroke(s) {
    if (!s) return;
    const c = state.ctx;
    c.beginPath();
    c.moveTo(s.x1, s.y1);
    c.lineTo(s.x2, s.y2);
    c.strokeStyle = s.color || '#000';
    c.lineWidth = s.width || 2;
    c.lineCap = 'round';
    c.stroke();
  }

  function queueCursor(p) {
    state.pendingCursor = p;
    if (state.cursorTimer) return;
    state.cursorTimer = setTimeout(() => {
      state.cursorTimer = 0;
      if (state.pendingCursor) {
        send('cursor', state.pendingCursor);
        state.pendingCursor = null;
      }
    }, 33);
  }

  function paintLoop() {
    const now = performance.now();
    for (const [id, c] of state.cursors) {
      if (now - c.last > 5000) state.cursors.delete(id);
    }
    drawCursors();
    requestAnimationFrame(paintLoop);
  }

  const SVG = 'http://www.w3.org/2000/svg';
  function buildCursorEl(id, color, name) {
    const el = document.createElement('div');
    el.className = 'cursor';
    el.dataset.id = id;
    el.dataset.name = name;
    el.style.setProperty('--c', color);
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M1 1 L1 12 L4 9 L7 13 L9 12 L6 8 L11 8 Z');
    path.setAttribute('fill', color);
    path.setAttribute('stroke', '#000');
    path.setAttribute('stroke-width', '0.5');
    svg.append(path);
    el.append(svg);
    return el;
  }

  function drawCursors() {
    const layer = ensureCursorLayer();
    const seen = new Set();
    const rect = state.canvas.getBoundingClientRect();
    for (const [id, c] of state.cursors) {
      let el = layer.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!el) {
        el = buildCursorEl(id, c.color, c.name);
        layer.append(el);
      }
      el.style.left = `${rect.left + c.x}px`;
      el.style.top = `${rect.top + c.y}px`;
      seen.add(id);
    }
    for (const el of layer.querySelectorAll('.cursor')) {
      if (!seen.has(el.dataset.id)) el.remove();
    }
  }

  function ensureCursorLayer() {
    let layer = document.getElementById('cursors');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'cursors';
      document.body.append(layer);
    }
    return layer;
  }

  init();
})();
