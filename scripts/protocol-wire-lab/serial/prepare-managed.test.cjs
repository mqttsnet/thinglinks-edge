/* global process, __dirname */
const {test}=require('node:test');const assert=require('node:assert/strict');const {spawnSync}=require('node:child_process');const {join}=require('node:path');
test('native artifact helper rejects protected or mismatched instances before accessing modules',()=>{
 for(const [arg,id] of [['line-1','line-1'],['ui-cloud-0909','line-1'],['ui-cloud-0909','']]){
  const result=spawnSync(process.execPath,[join(__dirname,'prepare-managed.cjs'),arg],{env:{TLE_INSTANCE_ID:id},encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/explicitly authorized temporary instance|identity does not match/);
 }
});
