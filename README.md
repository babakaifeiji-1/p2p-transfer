# P2P 文件传输

纯前端的跨外网文件传输工具。两台电脑打开同一个网页，输入配对码就能直接互传文件，不需要自己的服务器。

- 基于 WebRTC DataChannel 点对点传输，DTLS 端到端加密，文件不经过任何服务器
- 用 PeerJS 免费公共信令服务器交换连接信息（只传几 KB 的握手数据）
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

如果一方处于对称型 NAT（部分 4G/5G、公司网络），P2P 打洞会失败，页面会提示"连接超时"。
解决办法：在 `config.js` 的 `iceServers` 中加入 TURN 服务器（Cloudflare、Metered.ca 等有免费额度）。
注意 `config.js` 是公开的，请使用有流量上限的 TURN 账号。

## 测试

```bash
python3 test/run_test.py          # 需要本机安装 Chrome，可用 CHROME=/path/to/chrome 指定
```

在无头 Chrome 中用两个本地 RTCPeerConnection 测试传输协议：0B ~ 20MB 各种边界大小的数据完整性、拒绝、中途取消、反向发送、断线处理。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` / `style.css` | 页面 |
| `app.js` | 配对、连接、UI |
| `transfer.js` | 传输协议（分块、背压、确认、取消），不依赖 PeerJS |
| `config.js` | STUN/TURN、信令服务器配置 |
