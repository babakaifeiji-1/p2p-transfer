/*
 * 文件传输协议层（与 UI / PeerJS 无关，只依赖一个已打开的 RTCDataChannel）
 *
 * 控制消息使用 JSON 字符串，文件数据使用二进制 ArrayBuffer：
 *   发送方 -> offer {id,name,size,type}
 *   接收方 -> accept {id} | reject {id}
 *   发送方 -> [二进制分块...] -> end {id}
 *   接收方 -> ack {id} | nack {id,reason}
 *   任意方 -> cancel {id}
 * 每个方向同一时刻只传一个文件，DataChannel 是可靠有序的，所以二进制块一定属于当前文件。
 */
'use strict';
(function (global) {
  const CHUNK_SIZE = 64 * 1024;          // 每块 64KB
  const HIGH_WATER = 8 * 1024 * 1024;    // 发送缓冲超过 8MB 就暂停
  const LOW_WATER = 1 * 1024 * 1024;     // 降到 1MB 以下再继续

  let seq = 0;
  const newId = () =>
    Date.now().toString(36) + '-' + (seq++).toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  // 远端传来的文件名不可信，去掉路径分隔符和控制字符
  function sanitizeName(name) {
    const s = String(name == null ? '' : name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200);
    return s || 'file';
  }

  const ACTIVE_OUT = ['waiting', 'sending', 'verifying'];
  const ACTIVE_IN = ['offered', 'receiving', 'finishing'];

  class Session {
    /**
     * @param {RTCDataChannel} dc 已打开的数据通道
     * @param {{onUpdate?:Function, onOffer?:Function, onClose?:Function}} hooks
     */
    constructor(dc, hooks = {}) {
      this.dc = dc;
      this.hooks = hooks;
      this.outQueue = [];
      this.out = null;     // 当前正在发送的
      this.in = null;      // 当前正在接收的
      this.closed = false;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW_WATER;
      this._onMessage = (e) => this._handle(e.data);
      this._onClose = () => this._teardown('连接已断开');
      dc.addEventListener('message', this._onMessage);
      dc.addEventListener('close', this._onClose);
    }

    /* ---------- 公共 API ---------- */

    sendFiles(files) {
      if (this.closed) return;
      for (const file of files) {
        const tx = {
          id: newId(), dir: 'out', name: file.name, size: file.size, type: file.type || '',
          bytes: 0, state: 'queued', file, startedAt: 0,
        };
        this.outQueue.push(tx);
        this._update(tx);
      }
      this._pump();
    }

    /** 接受当前的 offer。sink: {write(buf), close() -> result, abort()} */
    accept(tx, sink) {
      if (tx !== this.in || tx.state !== 'offered' || this.closed) return false;
      tx.sink = sink;
      tx.state = 'receiving';
      tx.startedAt = performance.now();
      this._update(tx);
      this._sendCtrl({ t: 'accept', id: tx.id });
      return true;
    }

    reject(tx) {
      if (tx !== this.in || tx.state !== 'offered') return;
      tx.state = 'rejected';
      this._update(tx);
      this._sendCtrl({ t: 'reject', id: tx.id });
    }

    cancel(tx) {
      if (tx.dir === 'out') {
        const i = this.outQueue.indexOf(tx);
        if (i >= 0) {
          this.outQueue.splice(i, 1);
          tx.state = 'cancelled';
          this._update(tx);
        } else if (tx === this.out && ACTIVE_OUT.includes(tx.state)) {
          this._sendCtrl({ t: 'cancel', id: tx.id });
          this._finishOut(tx, 'cancelled');
        }
      } else if (tx === this.in && ACTIVE_IN.includes(tx.state)) {
        this._sendCtrl({ t: 'cancel', id: tx.id });
        this._abortIn(tx, 'cancelled');
      }
    }

    isBusy() {
      return !!(this.outQueue.length ||
        (this.out && ACTIVE_OUT.includes(this.out.state)) ||
        (this.in && ['receiving', 'finishing'].includes(this.in.state)));
    }

    close() {
      this._teardown('连接已关闭');
      try { this.dc.close(); } catch (_) { /* ignore */ }
    }

    /* ---------- 内部实现 ---------- */

    _emit(name, ...args) {
      const fn = this.hooks[name];
      if (fn) { try { fn(...args); } catch (e) { console.error(e); } }
    }
    _update(tx) { this._emit('onUpdate', tx); }
    _sendCtrl(obj) {
      if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj));
    }

    _pump() {
      if (this.out || this.closed) return;
      const tx = this.outQueue.shift();
      if (!tx) return;
      this.out = tx;
      tx.state = 'waiting';
      this._update(tx);
      this._sendCtrl({ t: 'offer', id: tx.id, name: tx.name, size: tx.size, type: tx.type });
    }

    _finishOut(tx, state, error) {
      tx.state = state;
      if (error) tx.error = error;
      this._update(tx);
      if (this.out === tx) {
        this.out = null;
        this._pump();
      }
    }

    _waitDrain() {
      const dc = this.dc;
      if (dc.readyState !== 'open') return Promise.reject(new Error('连接已断开'));
      if (dc.bufferedAmount <= HIGH_WATER) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          dc.removeEventListener('bufferedamountlow', ok);
          dc.removeEventListener('close', fail);
        };
        const ok = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('连接已断开')); };
        dc.addEventListener('bufferedamountlow', ok);
        dc.addEventListener('close', fail);
      });
    }

    async _stream(tx) {
      tx.state = 'sending';
      tx.startedAt = performance.now();
      this._update(tx);
      try {
        let offset = 0;
        while (offset < tx.size) {
          const buf = await tx.file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
          if (buf.byteLength === 0) throw new Error('读取文件失败（文件可能已被修改或删除）');
          await this._waitDrain();
          if (tx.state !== 'sending') return; // 期间被取消
          this.dc.send(buf);
          offset += buf.byteLength;
          tx.bytes = offset;
          this._update(tx);
        }
        if (tx.state !== 'sending') return;
        this._sendCtrl({ t: 'end', id: tx.id });
        tx.state = 'verifying'; // 等待对方 ack
        this._update(tx);
      } catch (e) {
        if (tx.state === 'sending') {
          this._sendCtrl({ t: 'cancel', id: tx.id });
          this._finishOut(tx, 'failed', e.message || String(e));
        }
      }
    }

    _handle(data) {
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }
        if (msg && typeof msg === 'object') this._handleCtrl(msg);
        return;
      }
      const tx = this.in;
      if (!tx || tx.state !== 'receiving') return;
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
      tx.bytes += data.byteLength;
      if (tx.bytes > tx.size) {
        this._failIn(tx, '收到的数据超过文件大小');
        return;
      }
      tx.writeChain = tx.writeChain.then(() => tx.sink.write(data));
      tx.writeChain.catch((e) => {
        if (tx.state === 'receiving') this._failIn(tx, '写入失败：' + (e && e.message || e));
      });
      this._update(tx);
    }

    _handleCtrl(m) {
      const out = this.out;
      const inc = this.in;
      switch (m.t) {
        case 'offer': {
          if (typeof m.id !== 'string') return;
          if (inc && ACTIVE_IN.includes(inc.state)) {
            this._sendCtrl({ t: 'reject', id: m.id });
            return;
          }
          const size = Number(m.size);
          if (!Number.isSafeInteger(size) || size < 0) {
            this._sendCtrl({ t: 'reject', id: m.id });
            return;
          }
          const tx = {
            id: m.id, dir: 'in', name: sanitizeName(m.name), size, type: String(m.type || '').slice(0, 100),
            bytes: 0, state: 'offered', writeChain: Promise.resolve(), startedAt: 0,
          };
          this.in = tx;
          this._update(tx);
          this._emit('onOffer', tx);
          break;
        }
        case 'accept':
          if (out && out.id === m.id && out.state === 'waiting') this._stream(out);
          break;
        case 'reject':
          if (out && out.id === m.id && out.state === 'waiting') this._finishOut(out, 'rejected');
          break;
        case 'ack':
          if (out && out.id === m.id && out.state === 'verifying') this._finishOut(out, 'done');
          break;
        case 'nack':
          if (out && out.id === m.id && ACTIVE_OUT.includes(out.state)) {
            this._finishOut(out, 'failed', '对方保存失败：' + String(m.reason || '').slice(0, 200));
          }
          break;
        case 'end':
          if (inc && inc.id === m.id && inc.state === 'receiving') this._completeIn(inc);
          break;
        case 'cancel':
          if (out && out.id === m.id && ACTIVE_OUT.includes(out.state)) this._finishOut(out, 'cancelled', '对方已取消');
          if (inc && inc.id === m.id && ACTIVE_IN.includes(inc.state)) this._abortIn(inc, 'cancelled', '对方已取消');
          break;
        default:
          break;
      }
    }

    async _completeIn(tx) {
      tx.state = 'finishing';
      this._update(tx);
      try {
        await tx.writeChain;
        if (tx.state !== 'finishing') return;
        if (tx.bytes !== tx.size) throw new Error(`文件大小不匹配（${tx.bytes}/${tx.size}）`);
        tx.result = await tx.sink.close();
        if (tx.state !== 'finishing') return;
        tx.state = 'done';
        this._update(tx);
        this._sendCtrl({ t: 'ack', id: tx.id });
      } catch (e) {
        if (tx.state !== 'finishing') return;
        const reason = e && e.message || String(e);
        this._abortIn(tx, 'failed', reason);
        this._sendCtrl({ t: 'nack', id: tx.id, reason });
      }
    }

    _abortIn(tx, state, error) {
      tx.state = state;
      if (error) tx.error = error;
      if (tx.sink) {
        try { Promise.resolve(tx.sink.abort()).catch(() => {}); } catch (_) { /* ignore */ }
      }
      this._update(tx);
    }

    _failIn(tx, error) {
      this._sendCtrl({ t: 'cancel', id: tx.id });
      this._abortIn(tx, 'failed', error);
    }

    _teardown(reason) {
      if (this.closed) return;
      this.closed = true;
      this.dc.removeEventListener('message', this._onMessage);
      this.dc.removeEventListener('close', this._onClose);
      for (const tx of this.outQueue.splice(0)) { tx.state = 'failed'; tx.error = reason; this._update(tx); }
      if (this.out && ACTIVE_OUT.includes(this.out.state)) {
        const tx = this.out;
        tx.state = 'failed'; tx.error = reason; this._update(tx);
      }
      this.out = null;
      if (this.in && ACTIVE_IN.includes(this.in.state)) this._abortIn(this.in, 'failed', reason);
      this._emit('onClose', reason);
    }
  }

  /* ---------- 接收端的数据落地方式 ---------- */

  // 存在内存里，完成后得到 Blob（不支持 File System Access API 的浏览器使用）
  function memorySink(type) {
    let chunks = [];
    return {
      write(buf) { chunks.push(buf); },
      close() { const blob = new Blob(chunks, { type: type || 'application/octet-stream' }); chunks = []; return blob; },
      abort() { chunks = []; },
    };
  }

  // 边收边写入磁盘（Chrome / Edge 支持），大文件不占内存
  function diskSink(writable) {
    return {
      write(buf) { return writable.write(buf); },
      async close() { await writable.close(); return null; },
      abort() { return writable.abort(); },
    };
  }

  global.P2PTransfer = { Session, memorySink, diskSink, sanitizeName, CHUNK_SIZE };
})(typeof window !== 'undefined' ? window : globalThis);
