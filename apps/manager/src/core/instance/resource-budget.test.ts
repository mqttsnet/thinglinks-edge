import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertInstanceResourceBudget } from './resource-budget.ts';

const host = { cpuCount: 4, memTotalMb: 4096 };
test('reserves capacity for the host and counts stopped registered instances too', () => {
  const instances = [{ memLimit: 2048, cpuLimit: 2 }];
  assert.doesNotThrow(() => assertInstanceResourceBudget(host, instances, { memoryMb: 512, cpus: 0.5 }));
  assert.throws(() => assertInstanceResourceBudget(host, instances, { memoryMb: 2048, cpus: 0.5 }), /内存预算/);
  assert.throws(() => assertInstanceResourceBudget(host, instances, { memoryMb: 512, cpus: 2 }), /CPU 预算/);
});
test('invalid host readings or unbounded stored allocations cannot silently permit creation', () => {
  assert.throws(() => assertInstanceResourceBudget({ cpuCount: 0, memTotalMb: 4096 }, [], { memoryMb: 512, cpus: 0.5 }), /资源容量/);
  assert.throws(() => assertInstanceResourceBudget(host, [{ memLimit: 0, cpuLimit: 0 }], { memoryMb: 512, cpus: 0.5 }), /已有实例/);
});
test('one core hosts can run the normal half-core instance and retain host capacity', () => {
  assert.doesNotThrow(() => assertInstanceResourceBudget({ cpuCount: 1, memTotalMb: 2048 }, [], { memoryMb: 512, cpus: 0.5 }));
  assert.throws(() => assertInstanceResourceBudget({ cpuCount: 1, memTotalMb: 2048 }, [{ memLimit: 512, cpuLimit: 0.5 }], { memoryMb: 512, cpus: 0.5 }), /CPU 预算/);
});
