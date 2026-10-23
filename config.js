/*
 * 可选配置。
 * 默认只用免费的公共 STUN，大多数家庭宽带都能直连。
 * 如果出现"一直连不上"（通常是一方处于对称型 NAT，比如部分 4G/5G 或公司网络），
 * 可以在这里加一个 TURN 中转服务器，例如 Cloudflare 或 Metered.ca 的免费额度：
 *   { urls: 'turn:your.turn.server:3478', username: 'xxx', credential: 'yyy' }
 * 注意：此文件会公开在 GitHub Pages 上，TURN 账号会被所有人看到，请使用有流量上限的账号。
 */
window.P2P_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  // PeerJS 信令服务器。null = 使用 PeerJS 官方免费公共服务器（0.peerjs.com）
  peerServer: null,
};
