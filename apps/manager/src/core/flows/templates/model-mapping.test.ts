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

const multiModel = (): ProductModel => ({
  ...model(), services: [...model().services!, {
    serviceCode: 'environment',
    properties: [{ propertyCode: 'temperature', datatype: 'boolean' }, { propertyCode: 'count', datatype: 'integer' }],
    commands: [{ commandCode: 'set', requests: [{ parameterCode: 'value', datatype: 'boolean', required: true }] }],
  }],
});
const multiParameters = () => ({
  ...parameters(), serviceCode: '', downlinkEnabled: false,
  points: [
    { serviceCode: 'control', property: 'temperature', source: '0', dataType: 'float32be', scale: 1, offset: 0 },
    { serviceCode: 'environment', property: 'temperature', source: '1', dataType: 'boolean', scale: 1, offset: 0 },
    { serviceCode: 'environment', property: 'count', source: '2', dataType: 'uint16be', scale: 1, offset: 0 },
  ],
});

test('point mappings resolve each service independently with an empty default and identical property names', () => {
  const input = multiParameters(), before = structuredClone(input);
  assert.doesNotThrow(() => validateTemplateModelMappings(input, multiModel()));
  assert.deepEqual(input, before, 'model checks must not rewrite parameters');
  assert.doesNotThrow(() => validateTemplateModelMappings({ ...input, serviceCode: 'control', points: input.points.map((point, index) => index === 0 ? { ...point, serviceCode: '' } : point) }, multiModel()));
  assert.throws(() => validateTemplateModelMappings({ ...input, points: input.points.map((point, index) => index === 1 ? { ...point, dataType: 'number' } : point) }, multiModel()), /environment.*temperature.*类型/);
  assert.throws(() => validateTemplateModelMappings({ ...input, points: [...input.points, input.points[0]!] }, multiModel()), /重复/);
});

test('missing or ambiguous service/property definitions never fall back to a peer service', () => {
  const input = multiParameters();
  assert.throws(() => validateTemplateModelMappings({ ...input, points: [{ ...input.points[0], serviceCode: 'missing' }] }, multiModel()), /服务.*missing/);
  const value = multiModel(); value.services![1]!.properties = [{ propertyCode: 'count', datatype: 'integer' }];
  assert.throws(() => validateTemplateModelMappings(input, value), /environment.*temperature/);
  const duplicate = multiModel(); duplicate.services!.push(structuredClone(duplicate.services![1]!));
  assert.throws(() => validateTemplateModelMappings(input, duplicate), /服务.*environment.*重复/);
});

test('same-named commands use their own services while explicit cross-service targets keep type checks', () => {
  const input = { ...multiParameters(), downlinkEnabled: true, commands: [
    { serviceCode: 'control', cmd: 'set', param: 'value', targetServiceCode: 'environment', property: 'count' },
    { serviceCode: 'environment', cmd: 'set', param: 'value', property: 'temperature' },
  ] };
  assert.doesNotThrow(() => validateTemplateModelMappings(input, multiModel()));
  assert.throws(() => validateTemplateModelMappings({ ...input, commands: [{ ...input.commands[0], property: 'temperature' }] }, multiModel()), /参数.*类型/);
  assert.throws(() => validateTemplateModelMappings({ ...input, commands: [{ ...input.commands[0], targetServiceCode: 'missing' }] }, multiModel()), /点位/);
  const missing = multiModel(); missing.services![1]!.commands = [];
  assert.throws(() => validateTemplateModelMappings(input, missing), /environment.*set/);
});

test('extra required parameters and duplicate definitions are checked in the command service', () => {
  const input = { ...multiParameters(), downlinkEnabled: true, commands: [{ serviceCode: 'environment', cmd: 'set', param: 'value', property: 'temperature' }] };
  const required = multiModel(); required.services![1]!.commands![0]!.requests!.push({ parameterCode: 'confirm', datatype: 'boolean' });
  assert.throws(() => validateTemplateModelMappings(input, required), /必填参数.*confirm/);
  const duplicate = multiModel(); duplicate.services![1]!.commands![0]!.requests!.push({ parameterCode: 'value', datatype: 'boolean' });
  assert.throws(() => validateTemplateModelMappings(input, duplicate), /参数.*重复/);
});

test('cached multi-service validation permits an empty default and keeps the exact product/version lookup', () => {
  const multiFields = fields.map(field => field.key === 'serviceCode' ? { ...field, required: false, default: '' }
    : field.key === 'points' ? { ...field, columns: [...field.columns!, { key: 'serviceCode', label: '服务', type: 'text' as const, default: '' }] }
      : field);
  const queries: string[][] = [];
  const input = { productIdentification: 'meter-product', versionNo: 'v1', serviceCode: '',
    points: multiParameters().points.map(({ serviceCode, property, dataType }) => ({ serviceCode, property, dataType })) };
  assert.equal(checkCachedTemplateModelMappings(input, multiFields, (product, version) => {
    queries.push([product, version]); return multiModel();
  }), true);
  assert.deepEqual(queries, [['meter-product', 'v1']]);
  assert.equal(checkCachedTemplateModelMappings(input, multiFields, () => undefined), false);
});
