'use strict';
(function () {
  const { Session, memorySink, diskSink } = window.P2PTransfer;
  const cfg = window.P2P_CONFIG || {};

  const ID_PREFIX = 'bkfj-p2pft-';                       // 避免与其他使用 PeerJS 公共服务器的应用撞 ID
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉易混淆的 0/O/1/I/L
  const CODE_RE = /^[A-Z0-9]{6}$/;
  const MEMORY_WARN = 1024 * 1024 * 1024;               // 内存模式下超过 1GB 提示
  const canSaveToDisk = typeof window.showSaveFilePicker === 'function';

  const $ = (id) => document.getElementById(id);
  const ui = {
    myCode: $('myCode'), copyLink: $('copyLinkBtn'), form: $('connectForm'), remote: $('remoteCode'),
    connect: $('connectBtn'), disconnect: $('disconnectBtn'), status: $('status'),
    drop: $('dropZone'), file: $('fileInput'), list: $('transfers'), empty: $('emptyHint'),
    saveMode: $('saveMode'), dialog: $('offerDialog'), offerText: $('offerText'),
  };

  let peer = null;
  let myCode = '';
  let conn = null;       // PeerJS DataConnection
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

  function setConnectedUI(connected) {
    ui.connect.disabled = connected || !myCode;
    ui.remote.disabled = connected;
    ui.disconnect.hidden = !connected;
    ui.drop.setAttribute('aria-disabled', String(!connected));
  }

  /* ---------------- 信令 / Peer ---------------- */

  function startPeer() {
    myCode = randomCode();
    const opts = { config: { iceServers: cfg.iceServers || [] }, debug: 1 };
    if (cfg.peerServer) Object.assign(opts, cfg.peerServer);
    peer = new Peer(ID_PREFIX + myCode, opts);

    peer.on('open', () => {
      ui.myCode.textContent = myCode;
      ui.copyLink.disabled = false;
      if (!conn) {
        ui.connect.disabled = false;
        setStatus('就绪。把配对码告诉对方，或输入对方的配对码。');
      }
      if (pendingConnect && CODE_RE.test(pendingConnect)) {
        ui.remote.value = pendingConnect;
        pendingConnect = '';
        history.replaceState(null, '', location.pathname + location.search);
        connectTo(ui.remote.value);
      }
    });

    peer.on('connection', (c) => {
      if (conn) {
        // 只允许一个连接，拒绝其他人
        c.on('open', () => c.close());
        return;
      }
      setStatus('有设备正在连接…');
      bindConnection(c);
    });

    peer.on('disconnected', () => {
      // 与信令服务器断开不影响已建立的 P2P 连接，静默重连即可
      if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 2000);
    });

    peer.on('error', (err) => {
      switch (err.type) {
        case 'unavailable-id':
          peer.destroy();
          startPeer(); // 配对码被占用，换一个
          return;
        case 'peer-unavailable':
          setStatus('找不到该配对码，请确认对方页面已打开且配对码正确。', 'err');
          resetConnection();
          return;
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed':
          setStatus('信令服务器连接异常，正在重试…（已建立的传输不受影响）', 'err');
          return;
        case 'browser-incompatible':
          setStatus('当前浏览器不支持 WebRTC，请使用最新版 Chrome / Edge / Firefox / Safari。', 'err');
          return;
        default:
          setStatus('出错：' + (err.message || err.type), 'err');
      }
    });
  }

  function connectTo(code) {
    code = String(code).trim().toUpperCase();
    if (!CODE_RE.test(code)) { setStatus('配对码应为 6 位字母或数字。', 'err'); return; }
    if (code === myCode) { setStatus('不能连接自己。', 'err'); return; }
    if (conn) return;
    setStatus('正在连接 ' + code + ' …');
    ui.connect.disabled = true;
    bindConnection(peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'raw' }));
  }

  function bindConnection(c) {
    conn = c;
    const remoteCode = String(c.peer).replace(ID_PREFIX, '');
    let opened = false;

    // 15 秒内没打通大概率是 NAT 穿透失败
    const timer = setTimeout(() => {
      if (!opened && conn === c) {
        setStatus('连接超时：双方网络可能无法直连（对称型 NAT）。可在 config.js 中配置 TURN 中转服务器。', 'err');
        c.close();
        resetConnection();
      }
    }, 15000);

    c.on('open', () => {
      opened = true;
      clearTimeout(timer);
      session = new Session(c.dataChannel, { onUpdate: render, onOffer: handleOffer, onClose: onSessionClose });
      setConnectedUI(true);
      setStatus('已连接 ' + remoteCode, 'ok');
      detectRoute(c).then((route) => {
        if (route && conn === c) setStatus(`已连接 ${remoteCode}（${route}）`, 'ok');
      });
    });
    c.on('close', () => { if (conn === c) onSessionClose('连接已断开'); });
    c.on('error', (e) => setStatus('连接出错：' + (e.message || e.type), 'err'));
  }

  // 通过 getStats 判断是 P2P 直连还是 TURN 中转
  async function detectRoute(c) {
    const pc = c.peerConnection;
    if (!pc) return '';
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

  function onSessionClose(reason) {
    if (ui.dialog.open) ui.dialog.close('reject');
    resetConnection();
    setStatus(reason + '。可重新输入配对码连接。', 'err');
  }

  function resetConnection() {
    const s = session;
    const c = conn;
    session = null;
    conn = null;
    if (s) s.close();
    if (c) { try { c.close(); } catch (_) { /* ignore */ } }
    setConnectedUI(false);
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
    resetConnection();
    setStatus('已断开。');
  });
  ui.copyLink.addEventListener('click', async () => {
    const link = location.origin + location.pathname + '#' + myCode;
    try {
      await navigator.clipboard.writeText(link);
      setStatus('邀请链接已复制，发给对方打开即可自动连接：' + link, 'ok');
    } catch (_) {
      setStatus('邀请链接：' + link);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (session && session.isBusy()) { e.preventDefault(); e.returnValue = ''; }
  });

  ui.saveMode.textContent = canSaveToDisk
    ? '接收模式：直接写入磁盘（支持超大文件）'
    : '接收模式：内存（建议单个文件不超过 1GB，超大文件请用 Chrome / Edge）';

  if (typeof window.Peer !== 'function') {
    setStatus('PeerJS 加载失败，请检查网络后刷新页面。', 'err');
    return;
  }
  setConnectedUI(false);
  startPeer();
})();
