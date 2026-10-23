/*
 * 可选配置（此文件会公开在 GitHub Pages 上，不要放敏感信息）。
 */
window.P2P_CONFIG = {
  /*
   * 信令中继：只用来交换几 KB 的握手信息（内容已用配对码派生的密钥加密），文件本身走 P2P。
   * 页面会同时连接所有中继，任意一个可用就能配对；某个服务被墙或宕机不影响使用。
   * type: mqtt（公共 MQTT Broker 的 WebSocket 地址，可选 username/password）| ntfy
   * 部分公司网络只放行 443 端口，所以至少保留一两个 443 端口的服务（shiftr、ntfy）。
   */
  relays: [
    { type: 'mqtt', name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
    { type: 'mqtt', name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { type: 'mqtt', name: 'Mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' },
    { type: 'mqtt', name: 'shiftr', url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
    { type: 'ntfy', name: 'ntfy', url: 'https://ntfy.sh' },
  ],

  /*
   * STUN 用于 NAT 打洞，大多数家庭宽带都能直连。
   * 如果出现"P2P 连接失败"（通常是一方处于对称型 NAT，比如部分 4G/5G 或公司网络），
   * 可以加一个 TURN 中转服务器，例如 Cloudflare 或 Metered.ca 的免费额度：
   *   { urls: 'turn:your.turn.server:3478', username: 'xxx', credential: 'yyy' }
   * TURN 账号会被所有人看到，请使用有流量上限的账号。
   */
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
  ],
};
