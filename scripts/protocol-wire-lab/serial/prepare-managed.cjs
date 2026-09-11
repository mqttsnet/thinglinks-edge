/* global process, console, __dirname */
/** Run explicitly inside the disposable managed test instance, never from a product lifecycle hook. */
const fs=require('node:fs');const {join,dirname}=require('node:path');const {createRequire}=require('node:module');const {createHash}=require('node:crypto');const assert=require('node:assert/strict');
const expected=process.argv[2];
assert.equal(expected,'ui-cloud-0909','this experiment is limited to the explicitly authorized temporary instance');
assert.equal(process.env.TLE_INSTANCE_ID,expected,'container instance identity does not match');
assert.equal(process.platform,'linux');assert.equal(process.arch,'arm64');
const root=createRequire('/data/package.json');assert.equal(root('node-red-contrib-modbus/package.json').version,'5.60.2');
const modbus=createRequire(root.resolve('@openp4nr/modbus-serial'));assert.equal(root('@openp4nr/modbus-serial/package.json').version,'8.4.0');
assert.equal(modbus('serialport/package.json').version,'10.5.0');const serial=createRequire(modbus.resolve('serialport'));
const metadata=serial.resolve('@serialport/bindings-cpp/package.json');assert.equal(JSON.parse(fs.readFileSync(metadata,'utf8')).version,'10.8.0');
const packageRoot=fs.realpathSync(dirname(metadata));assert.ok(packageRoot.startsWith('/data/node_modules/'),'binding must live within this instance module tree');
const manifest=JSON.parse(fs.readFileSync(join(__dirname,'manifest.json'),'utf8'));const source=join(__dirname,'bindings-10.8.0-arm64-musl.node');const hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex');assert.equal(hash,manifest.hashes['bindings-10.8.0-arm64-musl.node']);
const target=join(packageRoot,'build/Release/bindings.node');fs.mkdirSync(dirname(target),{recursive:true});fs.copyFileSync(source,target);fs.mkdirSync('/data/rtu-lab-evidence',{recursive:true});
console.log(JSON.stringify({instanceId:expected,bindingVersion:'10.8.0',target,sha256:hash,restartRequired:true}));
