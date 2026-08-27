/**
 * `@thinglinks` 节点集的共用部分。
 *
 * 这些节点在**实例容器内**运行，把设备、点位、点位值回报给 Manager，
 * 平台据此建立可信台账（06 号文方案 B）。用原生 modbus/opcua 节点采的部分
 * 平台看不见 —— 这是已知且如实告知用户的边界。
 *
 * 接入地址与令牌由 Manager 在创建实例时注入环境变量。缺失时节点**照常放行消息**，
 * 只是不回报：采集比台账重要，不能因为管理台连不上就把产线数据卡住。
 */
const MANAGER_URL = process.env.TLE_MANAGER_URL || '';
const INGEST_TOKEN = process.env.TLE_INGEST_TOKEN || '';
const INSTANCE_ID = process.env.TLE_INSTANCE_ID || '';

const enabled = () => MANAGER_URL !== '' && INGEST_TOKEN !== '';

/**
 * 向 Manager 回报。
 *
 * 刻意**不抛异常**：回报失败只影响台账，不该让用户的 flow 报错中断。
 * 失败时把状态点成红色并记一条 warn，现场看得见。
 */
async function report(node, path, body) {
  if (!enabled()) {
    node.warn('未注入 TLE_MANAGER_URL / TLE_INGEST_TOKEN，本节点只透传不回报');
    return false;
  }
  try {
    const res = await fetch(`${MANAGER_URL}/api/edge/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      node.warn(`回报失败 ${path}：HTTP ${res.status}`);
      node.status({ fill: 'red', shape: 'ring', text: `HTTP ${res.status}` });
      return false;
    }
    return true;
  } catch (e) {
    node.warn(`回报失败 ${path}：${e.message}`);
    node.status({ fill: 'red', shape: 'ring', text: '管理台不可达' });
    return false;
  }
}

module.exports = { report, enabled, MANAGER_URL, INSTANCE_ID };
