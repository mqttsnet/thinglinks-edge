import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filenameFrom } from './filename.ts';

const FB = 'fallback.tar';

test('纯 ASCII 时读 filename', () => {
  assert.equal(
    filenameFrom('attachment; filename="thinglinks-edge-backup.tar"', FB),
    'thinglinks-edge-backup.tar',
  );
});

test('中文名走 filename*，不退化成一串下划线', () => {
  // 后端两个字段一起给：老客户端读 filename，认得 RFC 5987 的读 filename*
  const disp = 'attachment; filename="flows_______.json"; '
    + `filename*=UTF-8''${encodeURIComponent('flows_产线采集基线.json')}`;
  assert.equal(filenameFrom(disp, FB), 'flows_产线采集基线.json');
});

test('大小写的 utf-8 都认', () => {
  assert.equal(filenameFrom(`attachment; filename*=utf-8''%E4%B8%AD.json`, FB), '中.json');
});

test('filename* 编码坏了就退回 filename，而不是抛出去', () => {
  // 单独一个 % 不是合法的百分号编码，decodeURIComponent 会抛 URIError；
  // 抛出去会让整个下载在解析文件名这一步失败 —— 内容明明已经拿到了
  const disp = `attachment; filename="ok.json"; filename*=UTF-8''%E4%B8%%`;
  assert.equal(filenameFrom(disp, FB), 'ok.json');
});

test('两个都没有时用兜底名', () => {
  assert.equal(filenameFrom('attachment', FB), FB);
  assert.equal(filenameFrom('', FB), FB);
});

test('filename* 解出空串时退回兜底名', () => {
  // a.download='' 会让浏览器改用 URL 末段做文件名，那是个 uuid
  assert.equal(filenameFrom(`attachment; filename*=UTF-8''`, FB), FB);
});
