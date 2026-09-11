import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveCanonicalTempParent as resolveNodesTempParent,
} from './verify-nodes.mjs';
import {
  resolveCanonicalTempParent as resolvePlatformTempParent,
} from './verify-platform-nodes.mjs';

const resolvers = [
  ['verify-nodes', resolveNodesTempParent],
  ['verify-platform-nodes', resolvePlatformTempParent],
];

for (const [name, resolveTempParent] of resolvers) {
  test(`${name} falls back to /tmp when Linux has no /private/tmp`, () => {
    const realpathCalls = [];
    const result = resolveTempParent({
      existsSync: (path) => path === '/tmp',
      realpathSync: (path) => {
        realpathCalls.push(path);
        return path;
      },
    });

    assert.equal(result, '/tmp');
    assert.deepEqual(realpathCalls, ['/tmp']);
  });

  test(`${name} prefers the canonical /private/tmp parent when available`, () => {
    const realpathCalls = [];
    const result = resolveTempParent({
      existsSync: () => true,
      realpathSync: (path) => {
        realpathCalls.push(path);
        return path;
      },
    });

    assert.equal(result, '/private/tmp');
    assert.deepEqual(realpathCalls, ['/private/tmp']);
  });

  test(`${name} rejects a canonical parent outside the verifier boundary`, () => {
    assert.throws(() => resolveTempParent({
      existsSync: () => false,
      realpathSync: () => '/var/tmp',
    }), /canonical temp parent escapes allowed boundary/);
  });
}
