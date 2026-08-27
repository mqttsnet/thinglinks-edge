/**
 * tl-uplink —— 上行的唯一出口。
 *
 * 为什么必须经平台而不是用户自己接 `mqtt out`（07 号文 6.2）：
 *   · 断网缓存与补传要由平台掌控，缓存在 flow 里平台管不着
 *   · `head/dataBody/dataSign` 信封与签名必须统一，散在各 flow 里必然出错
 *   · 微批聚合需要一个汇聚点
 *
 * 本节点只负责把数据交给 Manager；批量、缓存、续传在 Manager 侧做。
 */
const { report } = require('./tl-common.js');

module.exports = function (RED) {
  function TlUplinkNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.serviceId = (config.serviceId || '').trim();

    node.on('input', async function (msg, send, done) {
      const payload = msg.payload;
      if (payload === undefined || payload === null) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'payload 为空，已跳过' });
        send(msg);
        done();
        return;
      }

      const ok = await report(node, 'uplink', {
        serviceId: node.serviceId || msg.serviceId || 'default',
        // 子设备标识可由消息带上；不带则归到网关自身
        nodeId: msg.nodeId || config.deviceId || '',
        data: payload,
      });

      node.status(ok
        ? { fill: 'green', shape: 'dot', text: `已提交 ${new Date().toLocaleTimeString()}` }
        : { fill: 'red', shape: 'ring', text: '提交失败' });

      send(msg);
      done();
    });
  }

  RED.nodes.registerType('tl-uplink', TlUplinkNode);
};
