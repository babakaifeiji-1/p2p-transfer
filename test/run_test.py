"""在无头 Chrome 中运行 test/ 下的测试页，通过 DevTools 协议（--remote-debugging-pipe）读取结果。

不依赖第三方库，也不需要本地 HTTP 服务（file:// 方式加载），不访问外网。
用法: python3 test/run_test.py      可用环境变量 CHROME 指定浏览器路径
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = (os.environ.get("CHROME") or shutil.which("google-chrome")
          or shutil.which("chrome") or shutil.which("chromium"))

# e2e 测试注入到每个 frame 的脚本：
# - 把公共信令中继替换成经由顶层页面转发的内存中继（测试不访问外网）
# - 去掉 showSaveFilePicker，让接收走内存模式（无头环境无法弹出保存对话框）
# - 记录页面 JS 错误
E2E_INJECT = r"""
(() => {
  window.__errs = [];
  window.addEventListener('error', (e) => __errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => __errs.push('unhandled: ' + (e.reason && e.reason.message || e.reason)));
  if (window === window.top) { window.__bus = new Map(); return; }
  window.showSaveFilePicker = undefined;
  const bus = () => window.top.__bus;
  const relay = {
    name: 'mem', state: 'idle',
    start(topic, onData, onState) {
      if (!bus().has(topic)) bus().set(topic, new Set());
      this.fn = (d) => onData(d, 'mem');
      this.topic = topic;
      bus().get(topic).add(this.fn);
      setTimeout(() => { this.state = 'open'; onState(this); }, 50);
    },
    publish(topic, data) {
      if (this.state !== 'open') return false;
      for (const f of bus().get(topic) || []) setTimeout(() => f(data), 5);
      return true;
    },
    stop() { this.state = 'closed'; const s = bus().get(this.topic); if (s) s.delete(this.fn); },
  };
  let cfg;
  Object.defineProperty(window, 'P2P_CONFIG', {
    configurable: true,
    get: () => cfg,
    set: (v) => { cfg = Object.assign({}, v, { relays: [relay], iceServers: [] }); },
  });
})();
"""

SUITES = [
    ("传输协议", "test/test.html", None),
    ("信令/加密", "test/signaling_test.html", None),
    ("端到端（两个完整页面互传）", "test/e2e.html", E2E_INJECT),
]


class Pipe:
    """Chrome 从 fd 3 读命令、向 fd 4 写响应，消息以 \\0 分隔。"""

    def __init__(self, wfd, rfd):
        self.w, self.r, self.buf, self.next_id = wfd, rfd, b"", 0

    def call(self, method, params=None, session=None):
        self.next_id += 1
        msg = {"id": self.next_id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        os.write(self.w, json.dumps(msg).encode() + b"\0")
        while True:
            while b"\0" not in self.buf:
                chunk = os.read(self.r, 1 << 16)
                if not chunk:
                    raise RuntimeError("Chrome 已退出")
                self.buf += chunk
            raw, self.buf = self.buf.split(b"\0", 1)
            reply = json.loads(raw)
            if reply.get("id") == self.next_id:
                if "error" in reply:
                    raise RuntimeError(reply["error"])
                return reply["result"]


def launch():
    to_chrome_r, to_chrome_w = os.pipe()
    from_chrome_r, from_chrome_w = os.pipe()
    profile = tempfile.mkdtemp()

    def setup_fds():
        # 先挪到高位再 dup2，避免源 fd 恰好就是 3/4 时 dup2 变成空操作而保留 CLOEXEC
        a, b = os.dup(to_chrome_r), os.dup(from_chrome_w)
        os.dup2(a, 3)
        os.dup2(b, 4)
        os.set_inheritable(3, True)
        os.set_inheritable(4, True)

    proc = subprocess.Popen(
        [CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
         "--disable-features=WebRtcHideLocalIpsWithMdns", "--allow-file-access-from-files",
         "--remote-debugging-pipe", f"--user-data-dir={profile}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        preexec_fn=setup_fds, close_fds=False)  # close_fds 会在 preexec_fn 之后执行，必须关掉
    os.close(to_chrome_r)
    os.close(from_chrome_w)
    return proc, profile, Pipe(to_chrome_w, from_chrome_r)


def run_suite(cdp, path, inject):
    target = cdp.call("Target.createTarget", {"url": "about:blank"})["targetId"]
    sess = cdp.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
    cdp.call("Page.enable", {}, sess)
    if inject:
        cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": inject}, sess)
    cdp.call("Page.navigate", {"url": "file://" + os.path.join(ROOT, path)}, sess)
    for _ in range(100):  # 等页面脚本把 window.__done 挂上
        r = cdp.call("Runtime.evaluate", {"expression": "typeof window.__done"}, sess)
        if r["result"].get("value") == "object":
            break
        time.sleep(0.2)
    r = cdp.call("Runtime.evaluate", {"expression": "window.__done", "awaitPromise": True,
                                      "returnByValue": True, "timeout": 170000}, sess)
    cdp.call("Target.closeTarget", {"targetId": target})
    return r["result"].get("value") or {"error": json.dumps(r, ensure_ascii=False)}


def main():
    proc, profile, cdp = launch()
    all_ok = True
    try:
        for title, path, inject in SUITES:
            result = run_suite(cdp, path, inject)
            ok = "error" not in result and all(v for k, v in result.items() if k not in ("elapsedMs",))
            all_ok &= ok
            print(f"== {title}: {'PASS' if ok else 'FAIL'}")
            print(json.dumps(result, indent=2, ensure_ascii=False))
    finally:
        proc.kill()
        proc.wait()
        shutil.rmtree(profile, ignore_errors=True)
    print("ALL PASS" if all_ok else "FAILED")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
