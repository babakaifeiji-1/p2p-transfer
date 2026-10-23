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
   * STUN 用于 NAT 打洞，大多数家庭宽带都能直连。stun.l.google.com 在国内不可用，所以列了国内可用的备选。
   */
  iceServers: [
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    // 也可以直接在这里写固定的 TURN 账号（会公开在网页上）：
    // { urls: ['turn:xxx:3478', 'turns:xxx:443?transport=tcp'], username: '...', credential: '...' },
  ],

  /*
   * TURN 中转：公司网络、手机热点等无法直连的环境需要它（流量经 TURN 服务器转发）。
   * 填一个返回 iceServers 数组的地址，页面每次连接前会自动获取，例如 Metered.ca：
   *   'https://<你的应用名>.metered.live/api/v1/turn/credentials?apiKey=<API Key>'
   * 留空 = 只尝试 P2P 直连。
   */
  turnCredentialsUrl: '',
};
