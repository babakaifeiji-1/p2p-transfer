"""在无头 Chrome 中运行 test/test.html，通过 DevTools 协议（--remote-debugging-pipe）读取结果。

不依赖任何第三方库，也不需要本地 HTTP 服务（file:// 方式加载）。
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
URL = "file://" + os.path.join(ROOT, "test", "test.html")
CHROME = (os.environ.get("CHROME") or shutil.which("google-chrome")
          or shutil.which("chrome") or shutil.which("chromium"))


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


def main():
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
    try:
        cdp = Pipe(to_chrome_w, from_chrome_r)
        target = cdp.call("Target.createTarget", {"url": URL})["targetId"]
        sess = cdp.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        # 等页面脚本把 window.__done 挂上
        for _ in range(100):
            r = cdp.call("Runtime.evaluate", {"expression": "typeof window.__done"}, sess)
            if r["result"].get("value") == "object":
                break
            time.sleep(0.2)
        r = cdp.call("Runtime.evaluate", {"expression": "window.__done", "awaitPromise": True,
                                          "returnByValue": True, "timeout": 170000}, sess)
        return r["result"].get("value") or {"error": json.dumps(r)}
    finally:
        proc.kill()
        proc.wait()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    result = main()
    print(json.dumps(result, indent=2, ensure_ascii=False))
    passed = "error" not in result and all(v for k, v in result.items() if k != "elapsedMs")
    print("PASS" if passed else "FAIL")
    sys.exit(0 if passed else 1)
