import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateModelCommand} from './model-validation.ts';
import type {ProductModel,ModelCommandParameter} from '../model-client.ts';
const model=(requests:ModelCommandParameter[]):ProductModel=>({services:[{serviceCode:'control',commands:[{commandCode:'set',requests}]}]});
const field:ModelCommandParameter={parameterCode:'value',datatype:'int',required:'1',min:'0',max:'10'};

test('known models reject unknown commands, missing required values, wrong types and numeric bounds',()=>{
 for(const params of [{value:11},{value:-1},{value:1.5},{value:'5'},{value:NaN},{value:Number.MAX_SAFE_INTEGER+1},{extra:1},{}]){
  assert.ok(validateModelCommand(model([field]),'control','set',params).length>0);
 }
 assert.deepEqual(validateModelCommand(model([field]),'control','set',{value:5}),[]);
 assert.ok(validateModelCommand(model([field]),'other','set',{value:5}).length>0);
 assert.ok(validateModelCommand(model([field]),'control','other',{value:5}).length>0);
 assert.ok(validateModelCommand(model([field,{parameterCode:'confirm',datatype:'boolean',required:'1'}]),'control','set',{value:5}).length>0);
});

test('boolean, string length, finite decimals and explicit enum values follow declared constraints',()=>{
 assert.ok(validateModelCommand(model([{...field,datatype:'boolean'}]),'control','set',{value:1}).length>0);
 assert.deepEqual(validateModelCommand(model([{parameterCode:'value',datatype:'boolean'}]),'control','set',{value:true}),[]);
 const text=model([{parameterCode:'value',datatype:'string',maxlength:'3',enumlist:'["ON","OFF"]'}]);
 assert.deepEqual(validateModelCommand(text,'control','set',{value:'ON'}),[]);
 assert.ok(validateModelCommand(text,'control','set',{value:'OTHER'}).length>0);
 assert.ok(validateModelCommand(model([{parameterCode:'value',datatype:'decimal',min:'0',max:'1'}]),'control','set',{value:Infinity}).length>0);
 assert.deepEqual(validateModelCommand(model([{parameterCode:'value',datatype:'decimal',min:'0',max:'1'}]),'control','set',{value:0.5}),[]);
});
