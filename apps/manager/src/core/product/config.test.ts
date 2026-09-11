import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProductConfig } from './config.ts';

test('产品信息独立读取环境配置，公开结果不包含其它环境变量', () => {
  const p = loadProductConfig({ PRODUCT_NAME: 'Factory Edge', PRODUCT_GITHUB_REPOSITORY: 'factory/edge', PRODUCT_COMMUNITY_NAME: '工厂社区', PRODUCT_COMMUNITY_URL: 'https://example.com/community', PRODUCT_LOGO_URL: 'https://example.com/logo.svg', MASTER_KEY: 'never-expose' });
  assert.equal(p.name, 'Factory Edge');
  assert.equal(p.repositoryUrl, 'https://github.com/factory/edge');
  assert.equal(p.releasesUrl, 'https://github.com/factory/edge/releases');
  assert.equal(p.communityName, '工厂社区');
  assert.equal(p.logoUrl, 'https://example.com/logo.svg');
  assert.equal(p.docsUrl, 'https://github.com/factory/edge#readme');
  assert.equal(loadProductConfig({ PRODUCT_GITHUB_REPOSITORY: 'another/project', PRODUCT_DOCS_URL: 'auto' }).docsUrl, 'https://github.com/another/project#readme');
  assert.ok(!JSON.stringify(p).includes('never-expose'));
});

test('可关闭社区、仓库及远程更新记录，名称仍有默认值', () => {
  const p = loadProductConfig({ PRODUCT_COMMUNITY_URL: '', PRODUCT_GITHUB_REPOSITORY: '', PRODUCT_RELEASES_ENABLED: 'false' });
  assert.equal(p.repositoryUrl, '');
  assert.equal(p.communityUrl, '');
  assert.equal(p.releasesEnabled, false);
  assert.ok(p.name);
});

test('配置拒绝脚本地址、内嵌凭据和非法GitHub路径且错误不泄露原值', () => {
  for (const env of [{ PRODUCT_COMMUNITY_URL: 'javascript:alert(1)' }, { PRODUCT_LOGO_URL: 'https://user:secret@example.com/logo.svg' }, { PRODUCT_GITHUB_REPOSITORY: '../private?token=secret' }]) {
    assert.throws(() => loadProductConfig(env), error => error instanceof Error && !error.message.includes('secret'));
  }
});
