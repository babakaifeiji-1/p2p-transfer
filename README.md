# P2P 文件传输

纯前端的跨外网文件传输工具。两台电脑打开同一个网页，输入配对码就能直接互传文件，不需要自己的服务器。

- 基于 WebRTC DataChannel 点对点传输，DTLS 端到端加密，文件不经过任何服务器
- 握手信息同时通过多个免费公共中继（MQTT Broker、ntfy.sh）交换，任意一个能连通就能配对；
  握手内容用配对码派生的密钥（PBKDF2 + AES-GCM）加密，中继看不到内容
- 无任何第三方 JS 依赖，不需要 CDN
- 支持多文件排队、拖拽、双向发送、进度/速度显示、接收前确认
- Chrome / Edge 收到的文件直接流式写入磁盘，支持超大文件；其他浏览器先放在内存中（建议 ≤ 1GB）

## 使用

1. 两台电脑都打开网页，各自会显示一个 6 位配对码
2. 在一边输入另一边的配对码点"连接"（或点"复制邀请链接"发给对方，对方打开即自动连接）
3. 拖入文件发送，对方点"接收"

连接成功后状态栏会显示 `P2P 直连` 或 `TURN 中转`。

## 部署到 GitHub Pages

1. 在 GitHub 新建公开仓库 `p2p-transfer`，把本目录的文件推上去
2. 仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`
3. 约 1 分钟后访问 `https://<用户名>.github.io/p2p-transfer/`

## 连不上怎么办

页面上会显示"信令通道 N/5 可用"。如果是 0/5，说明当前网络把这些公共服务都拦了（常见于公司网络），换个网络（如手机热点）即可。
也可以在 `config.js` 的 `relays` 里加别的公共 MQTT Broker（需要支持 WebSocket over TLS）。

如果提示"P2P 连接失败"，页面会列出双方拿到的地址类型（内网 / 公网 / 中转）帮助判断问题在哪一侧。
公司网络、手机热点通常无法直连，需要 TURN 中转：

1. 注册 [Metered.ca](https://www.metered.ca/) 免费账号，创建 TURN 凭据，复制 API Key 和应用名
2. 打开页面 →「TURN 中转设置」，填入
   `https://<应用名>.metered.live/api/v1/turn/credentials?apiKey=<API Key>`，点「保存并测试」
3. 显示"✓ 可用并已保存"即可，设置只保存在本浏览器。一方配置即可，双方都配置更稳

也可以直接粘贴 iceServers JSON 数组，或在 `config.js` 的 `turnCredentialsUrl` 中设置全站默认值（会公开）。

## 测试

```bash
python3 test/run_test.py          # 需要本机安装 Chrome，可用 CHROME=/path/to/chrome 指定
```

全部在本地运行，不访问外网：
- 传输协议：两个本地 RTCPeerConnection，0B ~ 20MB 边界大小的数据完整性、拒绝、取消、反向发送、断线
- 信令/加密：MQTT 编解码（拆包/粘包）、加解密与防篡改、多中继去重、断线重连
- 端到端：两个 iframe 各运行完整页面，模拟配对 → 发送 → 确认接收 → 校验内容 → 断开 → 重连

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` / `style.css` | 页面 |
| `app.js` | 配对、WebRTC 连接、UI |
| `signaling.js` | 信令：多中继（内置极简 MQTT 客户端、ntfy）、加密、去重、重连 |
| `transfer.js` | 文件传输协议（分块、背压、确认、取消） |
| `config.js` | 信令中继、STUN/TURN 配置 |
