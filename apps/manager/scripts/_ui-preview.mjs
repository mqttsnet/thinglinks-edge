/** 临时预览：全新库（无账号），用来看首次设置那一屏。不进回归。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { buildServer } from '../dist/http/app.js';

const PORT = 13260;
const dataDir = mkdtempSync(join(tmpdir(), 'tle-setupprev-'));
const db = openDb(join(dataDir, 'edge.db'));
const key = deriveKey('preview-master', 'thinglinks-edge:instance-cred');
const auth = new AuthService(db, key);          // 刻意不建任何账号
const repo = new InstanceRepo(db, key);
const docker = new DockerClient({ network: 'n', imageRepo: 'nodered/node-red', portRange: { min: 30000, max: 30999 }, instanceDataRoot: '/tmp', timezone: 'Asia/Shanghai' });
const service = new InstanceService({ db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 }, allowedImageTags: ['5.0.4-24-minimal'] });
const app = buildServer({
  config: { externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false, allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1', listenPort: PORT, dataDir, portRange: { min: 30000, max: 30999 }, dataRoot: '/tmp', instanceDataRoot: '/tmp' },
  db, auth, repo, service,
  webRoot: resolve(process.cwd(), '../web-console/dist'),
});
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`preview on http://127.0.0.1:${PORT}  （全新库，应显示首次设置）`);
