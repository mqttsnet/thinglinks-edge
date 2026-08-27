/**
 * tl-tag —— 定义一个点位并上报它的当前值。
 *
 * 取值优先级：`msg.payload` 是对象且含本点位标识时取那一项，否则整个 payload 当作值。
 * 这样既支持一次采多点（payload 是对象），也支持单点直连。
 */
const { report } = require('./tl-common.js');

module.exports = function (RED) {
  function TlTagNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.deviceId = (config.deviceId || '').trim();
    node.tagId = (config.tagId || '').trim();

    if (node.deviceId === '' || node.tagId === '') {
      node.status({ fill: 'red', shape: 'ring', text: '未填设备或点位标识' });
      node.error('tl-tag：设备标识与点位标识都不能为空');
      return;
    }

    report(node, 'tags', {
      nodeId: node.deviceId,
      tagId: node.tagId,
      name: config.name || node.tagId,
      unit: config.unit || '',
      dataType: config.dataType || '',
    });

    node.on('input', function (msg, send, done) {
      const p = msg.payload;
      const value = (p !== null && typeof p === 'object' && node.tagId in p) ? p[node.tagId] : p;
      const quality = msg.quality || 'good';

      report(node, 'values', {
        values: [{ nodeId: node.deviceId, tagId: node.tagId, value, quality }],
      }).then((ok) => {
        if (ok) {
          const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
          node.status({ fill: 'green', shape: 'dot', text: shown.slice(0, 24) });
        }
      });

      send(msg);
      done();
    });
  }

  RED.nodes.registerType('tl-tag', TlTagNode);
};
