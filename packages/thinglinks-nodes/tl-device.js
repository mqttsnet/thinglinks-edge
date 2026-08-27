/**
 * tl-device —— 声明一台现场设备。
 *
 * 部署时把设备登记到平台台账；有消息经过时刷新在线状态。
 * 消息**原样透传**，本节点不改 payload —— 它是旁路登记，不是数据处理环节。
 */
const { report } = require('./tl-common.js');

module.exports = function (RED) {
  function TlDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.deviceId = (config.deviceId || '').trim();

    if (node.deviceId === '') {
      node.status({ fill: 'red', shape: 'ring', text: '未填设备标识' });
      node.error('tl-device：设备标识不能为空');
      return;
    }

    // 部署即登记。flow 重启会重放，服务端是幂等的
    report(node, 'devices', {
      nodeId: node.deviceId,
      name: config.name || node.deviceId,
      protocol: config.protocol || '',
      address: config.address || '',
      model: config.model || '',
      manufacturer: config.manufacturer || '',
    }).then((ok) => {
      if (ok) node.status({ fill: 'grey', shape: 'ring', text: '已登记' });
    });

    node.on('input', function (msg, send, done) {
      // 有数据流过即视为在线；离线由 Manager 侧按 last_seen 判定
      report(node, `devices/${encodeURIComponent(node.deviceId)}/status`, { online: true })
        .then((ok) => {
          if (ok) node.status({ fill: 'green', shape: 'dot', text: '在线' });
        });
      send(msg);
      done();
    });
  }

  RED.nodes.registerType('tl-device', TlDeviceNode);
};
