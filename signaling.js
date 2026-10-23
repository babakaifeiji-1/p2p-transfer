/*
 * 信令层：通过多个免费公共中继同时收发握手消息，任意一个能连通即可工作。
 *
 * - 每个配对码派生出 topic（订阅地址）和 AES-GCM 密钥（PBKDF2，增加暴力猜测成本）
 * - 发给对方的消息用"对方配对码"派生的密钥加密，中继服务器和其他订阅者看不到内容
 * - 同一条消息会从所有已连接的中继各发一份，接收端按消息 id 去重
 *
 * 支持的中继类型：
 *   mqtt   公共 MQTT Broker（WebSocket），内置极简 MQTT 3.1.1 客户端，只用 QoS 0
 *   ntfy   ntfy.sh 推送服务（WebSocket 订阅 + HTTP POST 发布）
 */
'use strict';
(function (global) {
  const APP_SALT = 'bkfj-p2pft-v1';
  const PBKDF2_ITERATIONS = 100000;
  const MAX_CLOCK_SKEW = 10 * 60 * 1000;
  const NTFY_MAX = 3900; // ntfy 超过 4096 字节会变成附件

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function randomId(len = 16) {
    const a = new Uint8Array(len);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => (b % 36).toString(36)).join('');
  }
  const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  function toB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    const s = atob(str);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /* ================= 加密 ================= */

  const secretCache = new Map();

  /** 从配对码派生 {topic, key} */
  function deriveSecrets(code) {
    if (!secretCache.has(code)) {
      secretCache.set(code, (async () => {
        const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
        const bits = new Uint8Array(await crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: enc.encode(APP_SALT), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, base, 384));
        const key = await crypto.subtle.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
        return { topic: toHex(bits.slice(0, 16)), key };
      })());
    }
    return secretCache.get(code);
  }

  async function transform(u8, Stream) {
    const s = new Blob([u8]).stream().pipeThrough(new Stream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const canCompress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  /** 加密：格式 = base64( flag(1) | iv(12) | ciphertext )，flag=1 表示明文经过 deflate 压缩 */
  async function seal(key, obj) {
    let plain = enc.encode(JSON.stringify(obj));
    let flag = 0;
    if (canCompress) {
      try { plain = await transform(plain, CompressionStream); flag = 1; } catch (_) { /* 不压缩 */ }
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    return toB64(concat(Uint8Array.of(flag), iv, ct));
  }

  /** 解密失败（不是发给我的 / 被篡改）返回 null */
  async function unseal(key, str) {
    try {
      const raw = fromB64(String(str));
      if (raw.length < 1 + 12 + 16) return null;
      let plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(1, 13) }, key, raw.subarray(13)));
      if (raw[0] === 1) {
        if (!canCompress) return null;
        plain = await transform(plain, DecompressionStream);
      }
      const obj = JSON.parse(dec.decode(plain));
      return obj && typeof obj === 'object' ? obj : null;
    } catch (_) {
      return null;
    }
  }

  /* ================= MQTT 3.1.1 极简编解码 ================= */

  const Mqtt = {
    remainingLength(n) {
      const out = [];
      do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b |= 0x80;
        out.push(b);
      } while (n > 0);
      return Uint8Array.from(out);
    },
    str(s) {
      const b = enc.encode(s);
      return concat(Uint8Array.of(b.length >> 8, b.length & 255), b);
    },
    packet(header, body) {
      return concat(Uint8Array.of(header), Mqtt.remainingLength(body.length), body);
    },
    connect(clientId, keepAlive, username, password) {
      let flags = 0x02; // clean session
      const payload = [Mqtt.str(clientId)];
      if (username != null) { flags |= 0x80; payload.push(Mqtt.str(username)); }
      if (username != null && password != null) { flags |= 0x40; payload.push(Mqtt.str(password)); }
      const vh = concat(Mqtt.str('MQTT'), Uint8Array.of(4, flags, keepAlive >> 8, keepAlive & 255)); // 协议级别 4 = 3.1.1
      return Mqtt.packet(0x10, concat(vh, ...payload));
    },
    subscribe(packetId, topic) {
      return Mqtt.packet(0x82, concat(Uint8Array.of(packetId >> 8, packetId & 255), Mqtt.str(topic), Uint8Array.of(0)));
    },
    publish(topic, payload) {
      return Mqtt.packet(0x30, concat(Mqtt.str(topic), payload));
    },
    pingreq: () => Uint8Array.of(0xc0, 0),
    disconnect: () => Uint8Array.of(0xe0, 0),

    /** 流式解析器：WebSocket 帧和 MQTT 包不一定一一对应，需要自己拼接/拆分 */
    parser(onPacket) {
      let buf = new Uint8Array(0);
      return (chunk) => {
        buf = concat(buf, new Uint8Array(chunk));
        for (;;) {
          if (buf.length < 2) return;
          let len = 0, mult = 1, i = 1, b;
          do {
            if (i >= buf.length) return;   // 剩余长度字段还没收全
            if (i > 4) throw new Error('MQTT 包长度字段非法');
            b = buf[i++];
            len += (b & 0x7f) * mult;
            mult *= 128;
          } while (b & 0x80);
          if (buf.length < i + len) return; // 包体还没收全
          const type = buf[0] >> 4;
          const flags = buf[0] & 0x0f;
          const body = buf.subarray(i, i + len);
          buf = buf.slice(i + len);
          const pkt = { type, flags, body };
          if (type === 3) {
            const tl = (body[0] << 8) | body[1];
            pkt.topic = dec.decode(body.subarray(2, 2 + tl));
            const qos = (flags >> 1) & 3;
            pkt.payload = body.subarray(2 + tl + (qos ? 2 : 0));
          }
          onPacket(pkt);
        }
      };
    },
  };

  /* ================= 中继传输实现 ================= */

  // 公共逻辑：自动重连（指数退避）
  class BaseRelay {
    constructor(cfg) {
      this.cfg = cfg;
      this.name = cfg.name || cfg.type;
      this.state = 'idle';
      this.ws = null;
      this.retry = 0;
      this.stopped = false;
      this.timers = new Set();
    }
    start(topic, onData, onState) {
      this.topic = topic;
      this.onData = onData;
      this.onState = onState || (() => {});
      this.stopped = false;
      this._connect();
    }
    stop() {
      this.stopped = true;
      this.timers.forEach(clearTimeout);
      this.timers.clear();
      clearInterval(this.ping);
      if (this.ws) { try { this.ws.close(); } catch (_) { /* ignore */ } }
      this._setState('closed');
    }
    _setState(s) {
      if (this.state === s) return;
      this.state = s;
      this.onState(this);
    }
    _later(fn, ms) {
      const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
      this.timers.add(t);
    }
    _connect() {
      if (this.stopped) return;
      this._setState('connecting');
      let ws;
      try { ws = this._open(); } catch (e) { this._onClosed(); return; }
      this.ws = ws;
      // 连接阶段 10 秒没成功就放弃本次，进入重试
      this._later(() => { if (this.ws === ws && this.state === 'connecting') ws.close(); }, 10000);
      ws.addEventListener('close', () => { if (this.ws === ws) this._onClosed(); });
      ws.addEventListener('error', () => { /* close 事件会随后触发 */ });
    }
    _onClosed() {
      clearInterval(this.ping);
      this.ws = null;
      if (this.stopped) return;
      this._setState('closed');
      const delay = Math.min(30000, 2000 * 2 ** this.retry++);
      this._later(() => this._connect(), delay);
    }
    _ready() {
      this.retry = 0;
      this._setState('open');
    }
  }

  class MqttRelay extends BaseRelay {
    _open() {
      const ws = new WebSocket(this.cfg.url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      const fullTopic = 'bkfj-p2pft/v1/' + this.topic;
      const parse = Mqtt.parser((p) => {
        if (p.type === 2) { // CONNACK
          if (p.body[1] !== 0) { ws.close(); return; }
          ws.send(Mqtt.subscribe(1, fullTopic));
        } else if (p.type === 9) { // SUBACK
          if (p.body[2] === 0x80) { ws.close(); return; }
          this._ready();
        } else if (p.type === 3 && p.topic === fullTopic) {
          this.onData(dec.decode(p.payload), this.name);
        }
      });
      ws.addEventListener('open', () => {
        ws.send(Mqtt.connect('bkfj' + randomId(16), 60, this.cfg.username, this.cfg.password));
        this.ping = setInterval(() => ws.readyState === 1 && ws.send(Mqtt.pingreq()), 30000);
      });
      ws.addEventListener('message', (e) => {
        try { parse(e.data); } catch (_) { ws.close(); }
      });
      return ws;
    }
    publish(topic, data) {
      if (this.state !== 'open') return false;
      this.ws.send(Mqtt.publish('bkfj-p2pft/v1/' + topic, enc.encode(data)));
      return true;
    }
    stop() {
      if (this.ws && this.ws.readyState === 1) { try { this.ws.send(Mqtt.disconnect()); } catch (_) { /* ignore */ } }
      super.stop();
    }
  }

  class NtfyRelay extends BaseRelay {
    base() { return (this.cfg.url || 'https://ntfy.sh').replace(/\/+$/, ''); }
    _open() {
      const ws = new WebSocket(this.base().replace(/^http/, 'ws') + '/bkfjp2p' + this.topic + '/ws');
      ws.addEventListener('message', (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.event === 'open') this._ready();
        else if (m.event === 'message' && typeof m.message === 'string') this.onData(m.message, this.name);
      });
      return ws;
    }
    publish(topic, data) {
      if (this.state !== 'open' || data.length > NTFY_MAX) return false;
      // 简单请求（text/plain + 查询参数），不触发 CORS 预检；cache=no 表示服务器不保留消息
      fetch(this.base() + '/bkfjp2p' + topic + '?cache=no&firebase=no', {
        method: 'POST', body: data, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
      }).catch(() => {});
      return true;
    }
  }

  const RELAY_TYPES = { mqtt: MqttRelay, ntfy: NtfyRelay };
  function createRelay(cfg) {
    const C = RELAY_TYPES[cfg.type];
    if (!C) throw new Error('未知的中继类型：' + cfg.type);
    return new C(cfg);
  }

  /* ================= 信令总线 ================= */

  class Signaling {
    /**
     * @param {{relays: Array, onMessage: Function, onStatus?: Function}} opts
     *   relays 可以是配置对象（{type,name,url}）或已实现 start/publish/stop 的对象（测试用）
     */
    constructor(opts) {
      this.relays = opts.relays.map((r) => (typeof r.publish === 'function' ? r : createRelay(r)));
      this.onMessage = opts.onMessage;
      this.onStatus = opts.onStatus || (() => {});
      this.seen = new Map(); // 消息 id -> 时间，用于去重
    }

    async start(myCode) {
      this.myCode = myCode;
      this.mine = await deriveSecrets(myCode);
      for (const r of this.relays) {
        r.start(this.mine.topic, (data, via) => this._incoming(data, via), () => this.onStatus(this.status()));
      }
      this.onStatus(this.status());
    }

    stop() { this.relays.forEach((r) => r.stop()); }

    status() { return this.relays.map((r) => ({ name: r.name, state: r.state })); }
    openCount() { return this.relays.filter((r) => r.state === 'open').length; }

    /** 发送给某个配对码，返回实际发出的中继数量 */
    async send(toCode, msg) {
      const s = await deriveSecrets(toCode);
      const data = await seal(s.key, Object.assign({}, msg, { id: randomId(16), from: this.myCode, ts: Date.now() }));
      let n = 0;
      for (const r of this.relays) {
        try { if (r.publish(s.topic, data)) n++; } catch (_) { /* 单个中继出错不影响其他 */ }
      }
      return n;
    }

    async _incoming(data, via) {
      if (!this.mine) return;
      const msg = await unseal(this.mine.key, data);
      if (!msg || typeof msg.id !== 'string' || typeof msg.from !== 'string') return;
      if (Math.abs(Date.now() - Number(msg.ts)) > MAX_CLOCK_SKEW) return; // 过期或重放
      if (this.seen.has(msg.id)) return;
      this.seen.set(msg.id, Date.now());
      if (this.seen.size > 500) { // 清理旧记录
        const cutoff = Date.now() - MAX_CLOCK_SKEW;
        for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
      }
      msg.via = via;
      this.onMessage(msg);
    }
  }

  global.P2PSignal = { Signaling, deriveSecrets, seal, unseal, Mqtt, createRelay, randomId };
})(typeof window !== 'undefined' ? window : globalThis);
