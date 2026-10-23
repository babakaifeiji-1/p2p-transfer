'use strict';
(function () {
  const { Session, memorySink, diskSink } = window.P2PTransfer;
  const { Signaling, randomId } = window.P2PSignal;
  const cfg = window.P2P_CONFIG || {};

  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉易混淆的 0/O/1/I/L
  const CODE_RE = /^[A-Z0-9]{6}$/;
  const MEMORY_WARN = 1024 * 1024 * 1024;               // 内存模式下超过 1GB 提示
  const CONNECT_TIMEOUT = 30000;                         // 发起连接后多久放弃
  const OFFER_RESEND = 3000;                             // 没收到应答时重发 offer 的间隔
  const ICE_GATHER_TIMEOUT = 3000;                       // 收集本机候选地址的最长等待
  const canSaveToDisk = typeof window.showSaveFilePicker === 'function';

  const $ = (id) => document.getElementById(id);
  const ui = {
    myCode: $('myCode'), copyLink: $('copyLinkBtn'), form: $('connectForm'), remote: $('remoteCode'),
    connect: $('connectBtn'), disconnect: $('disconnectBtn'), status: $('status'), relays: $('relayStatus'),
    drop: $('dropZone'), file: $('fileInput'), list: $('transfers'), empty: $('emptyHint'),
    saveMode: $('saveMode'), dialog: $('offerDialog'), offerText: $('offerText'),
  };

  let signaling = null;
  let myCode = '';
  let link = null;       // 当前 WebRTC 连接 {sid, remote, pc, role, timers, answer}
  let session = null;    // 传输会话
  let pendingConnect = (location.hash.slice(1) || '').toUpperCase();
  const rows = new Map(); // tx.id+dir -> {li, ...}

  /* ---------------- 工具函数 ---------------- */

  function randomCode() {
    const buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => ALPHABET[n % ALPHABET.length]).join('');
  }

  function fmtSize(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + ' ' + u[i];
  }

  function setStatus(text, kind) {
    ui.status.textContent = text;
    ui.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setConnectedUI(state) { // state: 'idle' | 'connecting' | 'connected'
    const ready = signaling && signaling.openCount() > 0;
    ui.connect.disabled = state !== 'idle' || !ready;
    ui.remote.disabled = state !== 'idle';
    ui.disconnect.hidden = state === 'idle';
    ui.disconnect.textContent = state === 'connecting' ? '取消' : '断开';
    ui.drop.setAttribute('aria-disabled', String(state !== 'connected'));
  }
  const uiState = () => (session ? 'connected' : link ? 'connecting' : 'idle');

  /* ---------------- 信令 ---------------- */

  function renderRelays(list) {
    const open = list.filter((r) => r.state === 'open').length;
    ui.relays.textContent = `信令通道 ${open}/${list.length} 可用：` +
      list.map((r) => `${r.name} ${r.state === 'open' ? '✓' : r.state === 'connecting' ? '…' : '✗'}`).join('　');
    ui.relays.className = 'hint' + (open ? '' : ' err');
    setConnectedUI(uiState());
    if (!open) {
      if (!link) setStatus('所有信令通道都连不上，正在重试…可能是当前网络限制了外网连接，可以换个网络（如手机热点）试试。', 'err');
      return;
    }
    if (!link && !session && /信令|正在启动/.test(ui.status.textContent)) {
      setStatus('就绪。把配对码告诉对方，或输入对方的配对码。');
    }
    if (pendingConnect && CODE_RE.test(pendingConnect)) {
      ui.remote.value = pendingConnect;
      pendingConnect = '';
      history.replaceState(null, '', location.pathname + location.search);
      connectTo(ui.remote.value);
    }
  }

  async function startSignaling() {
    // 同一个标签页刷新后保持配对码不变
    myCode = sessionStorage.getItem('p2p-code');
    if (!myCode || !CODE_RE.test(myCode)) {
      myCode = randomCode();
      sessionStorage.setItem('p2p-code', myCode);
    }
    ui.myCode.textContent = myCode;
    ui.copyLink.disabled = false;
    signaling = new Signaling({ relays: cfg.relays || [], onMessage: onSignal, onStatus: renderRelays });
    await signaling.start(myCode);
  }

  function onSignal(msg) {
    const from = String(msg.from).toUpperCase();
    if (!CODE_RE.test(from) || from === myCode || typeof msg.sid !== 'string') return;
    switch (msg.t) {
      case 'offer': return handleRemoteOffer(from, msg);
      case 'answer':
        if (link && link.role === 'caller' && link.remote === from && link.sid === msg.sid && !link.answered) {
          link.answered = true;
          link.pc.setRemoteDescription({ type: 'answer', sdp: String(msg.sdp) })
            .catch((e) => fail('无法建立连接：' + e.message));
        }
        return;
      case 'busy':
        if (link && link.remote === from && link.sid === msg.sid && !session) fail('对方正在与其他设备连接，请稍后再试。');
        return;
      case 'bye':
        if (link && link.remote === from && link.sid === msg.sid) {
          const wasConnected = !!session;
          closeLink(false);
          setStatus(wasConnected ? '对方已断开。' : '对方取消了连接。', 'err');
        }
        return;
      default:
    }
  }

  /* ---------------- WebRTC 连接 ---------------- */

  function newPeerConnection(l) {
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [] });
    pc.addEventListener('connectionstatechange', () => {
      if (link !== l) return;
      if (pc.connectionState === 'failed') {
        fail('P2P 连接失败：双方网络可能无法直连（对称型 NAT）。可在 config.js 中配置 TURN 中转服务器。');
      } else if (pc.connectionState === 'disconnected' && session) {
        setStatus('连接不稳定，正在尝试恢复…', 'err');
      } else if (pc.connectionState === 'connected' && session) {
        setStatus(`已连接 ${l.remote}${l.route ? '（' + l.route + '）' : ''}`, 'ok');
      }
    });
    return pc;
  }

  // 非 trickle 模式：等本机候选地址收集完（或超时）再一次性发送 SDP，信令消息更少
  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ICE_GATHER_TIMEOUT);
      function done() {
        clearTimeout(t);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      function check() { if (pc.iceGatheringState === 'complete') done(); }
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function bindChannel(l, dc) {
    dc.binaryType = 'arraybuffer';
    dc.addEventListener('open', () => {
      if (link !== l || session) return;
      l.timers.forEach(clearTimeout); l.timers.forEach(clearInterval); l.timers = [];
      session = new Session(dc, { onUpdate: render, onOffer: handleOffer, onClose: onSessionClose });
      setConnectedUI('connected');
      setStatus('已连接 ' + l.remote, 'ok');
      detectRoute(l.pc).then((route) => {
        l.route = route;
        if (route && link === l && session) setStatus(`已连接 ${l.remote}（${route}）`, 'ok');
      });
    });
  }

  async function connectTo(code) {
    code = String(code).trim().toUpperCase();
    if (!CODE_RE.test(code)) { setStatus('配对码应为 6 位字母或数字。', 'err'); return; }
    if (code === myCode) { setStatus('不能连接自己。', 'err'); return; }
    if (link) return;

    const l = { sid: randomId(12), remote: code, role: 'caller', timers: [], answered: false };
    link = l;
    setConnectedUI('connecting');
    setStatus('正在连接 ' + code + ' …');
    try {
      l.pc = newPeerConnection(l);
      bindChannel(l, l.pc.createDataChannel('file', { ordered: true }));
      await l.pc.setLocalDescription(await l.pc.createOffer());
      await gathered(l.pc);
      if (link !== l) return;
      const offer = { t: 'offer', sid: l.sid, sdp: l.pc.localDescription.sdp };
      const sendOffer = () => {
        if (link !== l || l.answered) return;
        signaling.send(code, offer).then((n) => {
          if (!n && link === l) setStatus('信令通道全部不可用，等待恢复…', 'err');
        });
      };
      sendOffer();
      // 对方可能稍后才上线、或某条中继丢消息，定时重发直到收到应答
      l.timers.push(setInterval(sendOffer, OFFER_RESEND));
      l.timers.push(setTimeout(() => {
        if (link !== l || session) return;
        fail(l.answered
          ? '连接超时：双方网络可能无法直连（对称型 NAT）。可在 config.js 中配置 TURN 中转服务器。'
          : '对方没有响应：请确认对方页面已打开、配对码正确。');
      }, CONNECT_TIMEOUT));
    } catch (e) {
      fail('无法创建连接：' + e.message);
    }
  }

  async function handleRemoteOffer(from, msg) {
    // 对方重发的同一个 offer：把之前的 answer 再发一次
    if (link && link.role === 'callee' && link.remote === from && link.sid === msg.sid) {
      if (link.answer) signaling.send(from, link.answer);
      return;
    }
    if (link) {
      // 双方同时点了连接：配对码小的一方作为发起方，另一方让步
      const glare = link.role === 'caller' && link.remote === from && !session;
      if (!(glare && myCode > from)) {
        if (!glare) signaling.send(from, { t: 'busy', sid: msg.sid });
        return;
      }
      closeLink(false);
    }

    const l = { sid: msg.sid, remote: from, role: 'callee', timers: [] };
    link = l;
    setConnectedUI('connecting');
    setStatus(from + ' 正在连接你…');
    try {
      l.pc = newPeerConnection(l);
      l.pc.addEventListener('datachannel', (e) => bindChannel(l, e.channel));
      await l.pc.setRemoteDescription({ type: 'offer', sdp: String(msg.sdp) });
      await l.pc.setLocalDescription(await l.pc.createAnswer());
      await gathered(l.pc);
      if (link !== l) return;
      l.answer = { t: 'answer', sid: l.sid, sdp: l.pc.localDescription.sdp };
      signaling.send(from, l.answer);
      l.timers.push(setTimeout(() => {
        if (link === l && !session) fail('连接超时：双方网络可能无法直连（对称型 NAT）。可在 config.js 中配置 TURN 中转服务器。');
      }, CONNECT_TIMEOUT));
    } catch (e) {
      fail('无法建立连接：' + e.message);
    }
  }

  // 通过 getStats 判断是 P2P 直连还是 TURN 中转
  async function detectRoute(pc) {
    for (let i = 0; i < 5; i++) {
      try {
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach((s) => {
          if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
        });
        if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
        const local = pair && stats.get(pair.localCandidateId);
        const remote = pair && stats.get(pair.remoteCandidateId);
        if (local && remote) {
          if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'TURN 中转';
          if (local.candidateType === 'host' && remote.candidateType === 'host') return '局域网直连';
          return 'P2P 直连';
        }
      } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return '';
  }

  function fail(text) {
    closeLink(true);
    setStatus(text, 'err');
  }

  function onSessionClose(reason) {
    if (!link) return;
    closeLink(true);
    setStatus(reason + '。可重新输入配对码连接。', 'err');
  }

  /** 关闭当前连接；notify=true 时通知对方 */
  function closeLink(notify) {
    const l = link;
    const s = session;
    link = null;
    session = null;
    if (ui.dialog.open) ui.dialog.close('reject');
    if (s) s.close();
    if (l) {
      l.timers.forEach(clearTimeout); l.timers.forEach(clearInterval);
      if (notify && signaling) signaling.send(l.remote, { t: 'bye', sid: l.sid });
      if (l.pc) { try { l.pc.close(); } catch (_) { /* ignore */ } }
    }
    setConnectedUI('idle');
  }

  /* ---------------- 接收 ---------------- */

  let currentOffer = null;

  function handleOffer(tx) {
    currentOffer = tx;
    let text = `对方想发送「${tx.name}」（${fmtSize(tx.size)}），是否接收？`;
    if (!canSaveToDisk && tx.size > MEMORY_WARN) {
      text += '\n当前浏览器会先把文件放在内存里，文件过大可能导致页面崩溃，建议使用 Chrome / Edge。';
    }
    ui.offerText.textContent = text;
    ui.offerText.style.whiteSpace = 'pre-line';
    if (!ui.dialog.open) ui.dialog.showModal();
  }

  // 按钮点击属于用户手势，可以直接调用 showSaveFilePicker
  ui.dialog.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    e.preventDefault();
    const tx = currentOffer;
    currentOffer = null;
    ui.dialog.close();
    if (!tx || !session) return;
    if (btn.value !== 'accept') { session.reject(tx); return; }

    if (canSaveToDisk) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: tx.name });
        const writable = await handle.createWritable();
        if (!session || !session.accept(tx, diskSink(writable))) writable.abort();
      } catch (err) {
        if (session) session.reject(tx);
        if (err && err.name !== 'AbortError') setStatus('无法创建文件：' + err.message, 'err');
      }
    } else {
      session.accept(tx, memorySink(tx.type));
    }
  });
  ui.dialog.addEventListener('cancel', (e) => { // Esc 键 = 拒绝
    e.preventDefault();
    const tx = currentOffer;
    currentOffer = null;
    ui.dialog.close();
    if (tx && session) session.reject(tx);
  });

  /* ---------------- 发送 ---------------- */

  function sendFiles(fileList) {
    if (!session) { setStatus('请先连接对方。', 'err'); return; }
    const files = Array.from(fileList || []);
    if (files.length) session.sendFiles(files);
  }

  ui.drop.addEventListener('click', () => { if (session) ui.file.click(); });
  ui.drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && session) { e.preventDefault(); ui.file.click(); }
  });
  ui.file.addEventListener('change', () => { sendFiles(ui.file.files); ui.file.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => ui.drop.addEventListener(t, (e) => {
    e.preventDefault();
    if (session) ui.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((t) => ui.drop.addEventListener(t, () => ui.drop.classList.remove('over')));
  ui.drop.addEventListener('drop', (e) => { e.preventDefault(); sendFiles(e.dataTransfer.files); });
  // 防止拖到页面其它地方时浏览器直接打开文件
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /* ---------------- 传输列表渲染 ---------------- */

  const STATE_TEXT = {
    queued: '排队中', waiting: '等待对方确认', sending: '发送中', verifying: '等待对方保存',
    offered: '等待你确认', receiving: '接收中', finishing: '正在保存',
    done: '完成', rejected: '已拒绝', cancelled: '已取消', failed: '失败',
  };
  const ACTIVE = new Set(['queued', 'waiting', 'sending', 'verifying', 'receiving', 'finishing']);

  function render(tx) {
    const key = tx.dir + ':' + tx.id;
    let r = rows.get(key);
    if (!r) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="tx-head"><span class="tx-dir"></span><span class="tx-name"></span>' +
        '<button type="button" class="tx-cancel">取消</button></div>' +
        '<progress max="100" value="0"></progress><div class="tx-meta"></div>';
      r = {
        li, name: li.querySelector('.tx-name'), cancel: li.querySelector('.tx-cancel'),
        bar: li.querySelector('progress'), meta: li.querySelector('.tx-meta'), last: 0, tx,
      };
      li.querySelector('.tx-dir').textContent = tx.dir === 'out' ? '⬆' : '⬇';
      li.querySelector('.tx-dir').setAttribute('aria-label', tx.dir === 'out' ? '发送' : '接收');
      r.name.textContent = tx.name;
      r.bar.setAttribute('aria-label', tx.name + ' 进度');
      r.cancel.addEventListener('click', () => { if (session) session.cancel(r.tx); });
      ui.list.prepend(li);
      ui.empty.hidden = true;
      rows.set(key, r);
    }
    r.tx = tx;

    // 进度更新很频繁，节流到每 200ms 一次（状态变化时立即刷新）
    const now = performance.now();
    const stateChanged = r.state !== tx.state;
    if (!stateChanged && now - r.last < 200) return;
    r.last = now;
    r.state = tx.state;

    const pct = tx.size ? (tx.bytes / tx.size) * 100 : (tx.state === 'done' ? 100 : 0);
    r.bar.value = pct;
    r.cancel.hidden = !ACTIVE.has(tx.state);

    let meta = `${STATE_TEXT[tx.state] || tx.state} · ${fmtSize(tx.bytes)} / ${fmtSize(tx.size)}`;
    if ((tx.state === 'sending' || tx.state === 'receiving') && tx.startedAt) {
      const sec = (now - tx.startedAt) / 1000;
      if (sec > 0.5) {
        const speed = tx.bytes / sec;
        meta += ` · ${fmtSize(speed)}/s`;
        if (speed > 0) meta += ` · 剩余约 ${Math.ceil((tx.size - tx.bytes) / speed)} 秒`;
      }
    }
    if (tx.error) meta += ' · ' + tx.error;
    r.meta.textContent = meta;
    r.meta.className = 'tx-meta' + (tx.state === 'failed' ? ' err' : tx.state === 'done' ? ' ok' : '');

    // 内存模式接收完成：生成下载链接
    if (tx.dir === 'in' && tx.state === 'done' && tx.result instanceof Blob && !r.link) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(tx.result);
      a.download = tx.name;
      a.textContent = '保存文件';
      r.link = a;
      r.meta.append(' · ', a);
      a.click();
    } else if (r.link) {
      r.meta.append(' · ', r.link);
    }
  }

  /* ---------------- 其它交互 ---------------- */

  ui.form.addEventListener('submit', (e) => { e.preventDefault(); connectTo(ui.remote.value); });
  ui.remote.addEventListener('input', () => {
    ui.remote.value = ui.remote.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  ui.disconnect.addEventListener('click', () => {
    if (session && session.isBusy() && !confirm('正在传输，确定断开吗？')) return;
    const wasConnected = !!session;
    closeLink(true);
    setStatus(wasConnected ? '已断开。' : '已取消连接。');
  });
  ui.copyLink.addEventListener('click', async () => {
    const url = location.origin + location.pathname + '#' + myCode;
    try {
      await navigator.clipboard.writeText(url);
      setStatus('邀请链接已复制，发给对方打开即可自动连接：' + url, 'ok');
    } catch (_) {
      setStatus('邀请链接：' + url);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (session && session.isBusy()) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => { if (link) closeLink(true); });

  ui.saveMode.textContent = canSaveToDisk
    ? '接收模式：直接写入磁盘（支持超大文件）'
    : '接收模式：内存（建议单个文件不超过 1GB，超大文件请用 Chrome / Edge）';

  if (!window.RTCPeerConnection || !window.crypto || !crypto.subtle) {
    setStatus('当前浏览器不支持 WebRTC 或加密接口，请使用最新版 Chrome / Edge / Firefox / Safari，并通过 https 打开。', 'err');
    return;
  }
  setConnectedUI('idle');
  setStatus('正在启动信令通道…');
  startSignaling().catch((e) => setStatus('启动失败：' + e.message, 'err'));
})();
