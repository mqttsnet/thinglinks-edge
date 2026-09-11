import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProductModel } from '../../cloud/model-client.ts';
import type { TemplateParameter } from './types.ts';
import { validateTemplateModelMappings, checkCachedTemplateModelMappings } from './model-mapping.ts';

const model = (): ProductModel => ({
  productIdentification: 'meter-product',
  services: [
    {
      serviceCode: 'control',
      properties: [
        { propertyCode: 'temperature', datatype: 'decimal' },
        { propertyCode: 'count', datatype: 'long' },
        { propertyCode: 'enabled', datatype: 'boolean' },
        { propertyCode: 'label', datatype: 'string' },
      ],
      commands: [
        {
          commandCode: 'set',
          requests: [
            { parameterCode: 'value', datatype: 'decimal', required: true },
            { parameterCode: 'optional', datatype: 'boolean', required: false },
          ],
        },
      ],
    },
  ],
});
const parameters = () => ({
  productIdentification: 'meter-product',
  versionNo: 'v1',
  serviceCode: 'control',
  points: [{ property: 'temperature', dataType: 'float32be', source: '0', scale: 1, offset: 0 }],
  downlinkEnabled: true,
  commands: [{ cmd: 'set', param: 'value', property: 'temperature' }],
});

test('binary source codecs map to cloud numeric values without comparing codec names to model datatypes', () => {
  for (const type of ['number', 'uint16be', 'int32le', 'float32swap']) {
    const values = {
      ...parameters(),
      points: [{ property: 'count', dataType: type }],
      downlinkEnabled: false,
    };
    assert.doesNotThrow(() => validateTemplateModelMappings(values, model()));
  }
  assert.doesNotThrow(() =>
    validateTemplateModelMappings(
      {
        ...parameters(),
        points: [
          { property: 'enabled', dataType: 'boolean' },
          { property: 'label', dataType: 'string' },
        ],
        downlinkEnabled: false,
      },
      model(),
    ),
  );
});

test('missing service or property and known scalar type mismatches are rejected', () => {
  assert.throws(
    () => validateTemplateModelMappings({ ...parameters(), serviceCode: 'missing' }, model()),
    /服务/,
  );
  assert.throws(
    () =>
      validateTemplateModelMappings(
        { ...parameters(), points: [{ property: 'missing', dataType: 'number' }] },
        model(),
      ),
    /属性/,
  );
  assert.throws(
    () =>
      validateTemplateModelMappings(
        { ...parameters(), points: [{ property: 'temperature', dataType: 'string' }] },
        model(),
      ),
    /类型/,
  );
  assert.throws(
    () =>
      validateTemplateModelMappings(
        { ...parameters(), points: [{ property: 'enabled', dataType: 'uint16be' }] },
        model(),
      ),
    /类型/,
  );
});

test('command and request parameter must be in the selected service and compatible with the target point', () => {
  assert.throws(
    () =>
      validateTemplateModelMappings(
        { ...parameters(), commands: [{ cmd: 'missing', param: 'value', property: 'temperature' }] },
        model(),
      ),
    /命令/,
  );
  assert.throws(
    () =>
      validateTemplateModelMappings(
        { ...parameters(), commands: [{ cmd: 'set', param: 'missing', property: 'temperature' }] },
        model(),
      ),
    /参数/,
  );
  const wrong = model();
  wrong.services![0]!.commands![0]!.requests![0]!.datatype = 'boolean';
  assert.throws(() => validateTemplateModelMappings(parameters(), wrong), /类型/);
  assert.throws(
    () =>
      validateTemplateModelMappings(
        { ...parameters(), commands: [{ cmd: 'set', param: 'value', property: 'missing' }] },
        model(),
      ),
    /点位/,
  );
});

test('single parameter mappings cannot satisfy another required command parameter', () => {
  for (const required of [true, '1', 1, undefined]) {
    const value = model();
    value.services![0]!.commands![0]!.requests!.push({
      parameterCode: 'confirm',
      datatype: 'boolean',
      ...(required === undefined ? {} : { required }),
    });
    assert.throws(() => validateTemplateModelMappings(parameters(), value), /必填参数.*confirm/);
  }
  assert.doesNotThrow(() => validateTemplateModelMappings(parameters(), model()));
});

test('hidden command mappings remain untouched and are ignored when control is disabled', () => {
  const input = {
    ...parameters(),
    downlinkEnabled: false,
    commands: [{ cmd: 'obsolete', param: 'old', property: 'missing' }],
  };
  const before = structuredClone(input);
  validateTemplateModelMappings(input, model());
  assert.deepEqual(input, before);
});

test('ambiguous cloud definitions and a different cached product are rejected', () => {
  const duplicate = model();
  duplicate.services![0]!.properties!.push({ propertyCode: 'temperature', datatype: 'decimal' });
  assert.throws(() => validateTemplateModelMappings(parameters(), duplicate), /重复/);
  assert.throws(
    () => validateTemplateModelMappings(parameters(), { ...model(), productIdentification: 'other-product' }),
    /产品/,
  );
});

const fields: TemplateParameter[] = [
  { key: 'productIdentification', label: '产品', type: 'text', default: '' },
  { key: 'versionNo', label: '版本', type: 'text', default: '' },
  { key: 'serviceCode', label: '服务', type: 'text', required: true },
  {
    key: 'points',
    label: '点表',
    type: 'table',
    default: [{ property: 'temperature', dataType: 'number' }],
    columns: [
      { key: 'property', label: '属性', type: 'text' },
      { key: 'dataType', label: '类型', type: 'text' },
    ],
  },
];
test('cache checks merge recipe defaults and only use the explicitly supplied product/version', () => {
  const lookedUp: string[][] = [];
  const lookup = (product: string, version: string) => {
    lookedUp.push([product, version]);
    return model();
  };
  assert.equal(
    checkCachedTemplateModelMappings(
      { productIdentification: 'meter-product', versionNo: 'v1', serviceCode: 'control' },
      fields,
      lookup,
    ),
    true,
  );
  assert.deepEqual(lookedUp, [['meter-product', 'v1']]);
  assert.equal(
    checkCachedTemplateModelMappings(
      { productIdentification: 'meter-product', serviceCode: 'control' },
      fields,
      lookup,
    ),
    false,
  );
  assert.equal(
    checkCachedTemplateModelMappings({ versionNo: 'v1', serviceCode: 'control' }, fields, lookup),
    false,
  );
  assert.equal(lookedUp.length, 1);
  assert.equal(
    checkCachedTemplateModelMappings(
      { productIdentification: 'meter-product', versionNo: 'v2', serviceCode: 'control' },
      fields,
      () => undefined,
    ),
    false,
  );
  const missingDefault = model();
  missingDefault.services![0]!.properties = [];
  assert.throws(
    () =>
      checkCachedTemplateModelMappings(
        { productIdentification: 'meter-product', versionNo: 'v1', serviceCode: 'control' },
        fields,
        () => missingDefault,
      ),
    /temperature/,
  );
});
