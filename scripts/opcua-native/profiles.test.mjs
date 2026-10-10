import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildProfile } from './profiles.mjs';
test('each accepted Node-RED profile resolves an immutable platform-specific base', () => {
  assert.equal(resolveBuildProfile('5.0.4-24-minimal', 'arm64').baseImage, 'nodered/node-red@sha256:7d57985fde220f7d223e008a2e8f97a46dcd432009fcdfaaaf00ed3e37a540ab');
  assert.equal(resolveBuildProfile('5.0.4-24-minimal', 'x64').nodeRed, '5.0.4');
  const profile = resolveBuildProfile('5.0.7-24-minimal', 'arm64');
  assert.equal(profile.nodeRed, '5.0.7');
  assert.equal(profile.baseImage, 'nodered/node-red@sha256:cc5408af21f1a1bb5ad14c330d31d02b533053ddb2c11fc6c2ce15810b360b48');
});
test('unverified 5.0.7 x64 and arbitrary image selectors fail closed', () => {
  for (const [profile, arch] of [['5.0.7-24-minimal','x64'],['latest','arm64'],['__proto__','arm64'],['5.0.7-24-minimal','armv7']]) {
    assert.throws(() => resolveBuildProfile(profile, arch), /Unsupported or unverified/);
  }
});
