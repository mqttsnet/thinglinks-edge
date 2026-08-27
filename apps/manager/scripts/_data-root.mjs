/**
 * 验证脚本共用的实例数据根。
 *
 * 生产默认是 `/data01/mqttsnet/thinglinks-edge/instances`，但验证要在开发机上跑，
 * 那个路径通常不存在（macOS 上根本没有 /data01），所以统一落到临时目录。
 *
 * 两条约束，改动前请先读：
 *   1. 必须是 Docker 默认共享的宿主路径。Docker Desktop 只共享
 *      /Users /Volumes /private /tmp 等少数几个，选别处 bind 挂载会直接失败。
 *   2. 目录权限给 0777 而非生产的 0770。实例容器以 uid 1000 运行，而脚本以
 *      当前登录用户建目录，两者 uid 不同；生产环境里 Manager 和实例同为 uid 1000，
 *      不存在这个错配。这是验证环境的妥协，不要照搬进生产配置。
 */
import { mkdir, rm } from 'node:fs/promises';

/** 验证用的 EDGE_DATA_ROOT（对应生产的 /data01/mqttsnet/thinglinks-edge） */
export const TEST_EDGE_ROOT = process.env.TLE_VERIFY_EDGE_ROOT || '/private/tmp/tle-verify';

/** 实例数据根，等于 <EDGE_DATA_ROOT>/instances */
export const TEST_DATA_ROOT = `${TEST_EDGE_ROOT}/instances`;

/** 准备数据根。每个脚本开跑前调一次。 */
export async function ensureRoot() {
  await mkdir(`${TEST_EDGE_ROOT}/manager`, { recursive: true, mode: 0o777 });
  await mkdir(TEST_DATA_ROOT, { recursive: true, mode: 0o777 });
}

/**
 * 把整个验证数据根清空，每个脚本开跑前调一次。
 *
 * 必须做这件事：数据根是 **bind 挂载**，`docker compose down -v` 不会碰它
 * （-v 只删具名卷）。不清就会带着上一轮的库开跑 —— 表现是
 * 「初始口令没打印」「登录 401」，而不是一眼可见的脏数据。
 */
export async function resetRoot() {
  // 只允许清自己那个前缀下的路径，防手滑
  if (!TEST_EDGE_ROOT.startsWith('/private/tmp/') && !TEST_EDGE_ROOT.startsWith('/tmp/')) {
    throw new Error(`拒绝清理非临时路径：${TEST_EDGE_ROOT}`);
  }
  await rm(TEST_EDGE_ROOT, { recursive: true, force: true });
  await ensureRoot();
}

/** 清掉某个实例的数据目录 —— 取代原先的 `docker volume rm`。 */
export async function resetDataDir(id) {
  await rm(`${TEST_DATA_ROOT}/${id}`, { recursive: true, force: true });
}

/** 该实例的数据目录是否存在。 */
export async function dataDirExists(id) {
  const { access } = await import('node:fs/promises');
  return access(`${TEST_DATA_ROOT}/${id}`).then(() => true).catch(() => false);
}

/** 该实例数据目录下的文件列表；目录不存在时返回空数组。 */
export async function dataDirFiles(id) {
  const { readdir } = await import('node:fs/promises');
  return readdir(`${TEST_DATA_ROOT}/${id}`).catch(() => []);
}
