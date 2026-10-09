import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpPollRecipe, httpReceiveRecipe } from './http.ts';
import { parameterDefaults, validateParameters } from '../parameters.ts';
import { getBuiltinTemplate, renderBuiltinTemplate } from '../catalog.ts';
import { listenerConflicts } from '../../listeners.ts';

const identity = { nodeId: 'sensor-http', serviceCode: 'telemetry' };
const poll = (overrides: Record<string, unknown> = {}) => httpPollRecipe.build(validateParameters(httpPollRecipe.parameters, { ...identity, url: 'https://device.example/data', ...overrides }));
const push = (overrides: Record<string, unknown> = {}) => httpReceiveRecipe.build(validateParameters(httpReceiveRecipe.parameters, { ...identity, ...overrides }));

test('HTTP poll requires a real URL while its disabled catalogue example stays readable', () => {
  assert.equal(parameterDefaults(httpPollRecipe.parameters).url, '');
  const preview = getBuiltinTemplate(httpPollRecipe.id)!;
  assert.equal(preview.parameters?.find(field => field.key === 'url')?.default, '');
  assert.equal(preview.flows.find(node => node.type === 'tab')?.disabled, true);
  assert.match(String(preview.flows.find(node => node.type === 'http request')?.url), /192\.0\.2\./);
  for (const url of [undefined, '', ' ']) assert.throws(() => renderBuiltinTemplate(httpPollRecipe.id, { ...identity, url }));
});

test('HTTP timeout remains 10000ms for old parameter archives and is configurable through the native message field', () => {
  assert.equal(parameterDefaults(httpPollRecipe.parameters).requestTimeout, 10000);
  const defaultStart = poll().find(node => node.id === 'http-start')!;
  assert.match(String(defaultStart.func), /msg\.requestTimeout = 10000;/);
  assert.match(String(poll({ requestTimeout: 1500 }).find(node => node.id === 'http-start')!.func), /msg\.requestTimeout = 1500;/);
  const timeout = httpPollRecipe.parameters.find(field => field.key === 'requestTimeout')!;
  assert.equal(timeout.group, 'advanced');
  assert.equal(timeout.min, 100); assert.equal(timeout.max, 60000);
  for (const requestTimeout of [100, 60000]) assert.ok(poll({ requestTimeout }));
  for (const requestTimeout of [0, -1, 99, 60001, 1.2, NaN, Infinity, '1000']) assert.throws(() => poll({ requestTimeout }));
});

test('HTTP guidance explains GET, JSON field paths, certificate verification and the actual protected push root', () => {
  const field = (key: string) => httpPollRecipe.parameters.find(item => item.key === key)!;
  assert.match(field('url').description!, /GET/);
  assert.match(field('url').description!, /127\.0\.0\.1.*实例/);
  assert.match(field('points').description!, /data\.temperature/);
  assert.match(field('interval').description!, /跳过/);
  assert.match(httpPollRecipe.notes.join('\n'), /证书.*校验/);
  assert.match(httpReceiveRecipe.parameters.find(item => item.key === 'path')!.description!, /httpNodeRoot/);
  assert.match(httpReceiveRecipe.notes.join('\n'), /basePath.*\/red\/\{实例\}\/api/);
  assert.match(httpReceiveRecipe.notes.join('\n'), /设备 HTTP 接入.*HMAC.*HTTPS/);
  assert.match(httpReceiveRecipe.notes.join('\n'), /1880.*编辑器/);
  assert.match(httpReceiveRecipe.notes.join('\n'), /202.*不代表/);
});

test('HTTP templates preserve native transport and reject URL credentials, unsupported schemes and invalid receive paths', () => {
  const request = poll().find(node => node.type === 'http request')!;
  assert.equal(request.method, 'GET'); assert.equal(request.ret, 'obj'); assert.equal(request.tls, ''); assert.equal(request.authType, '');
  assert.equal(request.rejectUnauthorized, undefined);
  for (const url of ['ftp://device/data', 'http://name:secret@device/data', 'http://device/data#fragment', 'not-a-url']) assert.throws(() => poll({ url }));
  for (const path of ['', '/', '//devices', '/devices//report', '/devices/:id', '/devices/*', '/devices/../report', '/devices/%2freport', '/devices/report?x=1', '/devices/report#part', '/' + 'a'.repeat(128)]) assert.throws(() => push({ path }));
  assert.equal(push({ path: '/devices/report' }).find(node => node.type === 'http in')?.method, 'post');
});

test('existing listener validation detects duplicate POST paths before a receive template is appended', () => {
  const incoming = push({ path: '/devices/report' });
  assert.equal(listenerConflicts(push({ path: '/devices/report/' }), incoming).length, 1);
  const existing = push({ path: '/devices/report' });
  existing.find(node => node.type === 'http in')!.method = 'get';
  assert.equal(listenerConflicts(existing, incoming).length, 0);
  existing.find(node => node.type === 'http in')!.method = 'all';
  assert.equal(listenerConflicts(existing, incoming).length, 1);
  existing.find(node => node.type === 'tab')!.disabled = true;
  assert.equal(listenerConflicts(existing, incoming).length, 0);
});
