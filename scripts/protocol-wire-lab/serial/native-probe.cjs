/* global process, console */
const {dirname}=require('node:path');const {createRequire}=require('node:module');const {readFileSync}=require('node:fs');const {createHash}=require('node:crypto');
const root=createRequire(process.env.LAB_MODULE_PACKAGE||'/data/runtime/package.json');
try {
 const serialRequire=createRequire(root.resolve('@openp4nr/modbus-serial'));
 const {SerialPort}=serialRequire('serialport');
 const bindingRequire=createRequire(serialRequire.resolve('serialport'));
 const bindingPath=bindingRequire.resolve('@serialport/bindings-cpp');
 const binary=fromBinding=>fromBinding('node-gyp-build').path(dirname(dirname(bindingPath)));
 const binaryPath=binary(createRequire(bindingPath));
 console.log(JSON.stringify({event:'NATIVE_LOADED',node:process.version,platform:process.platform,arch:process.arch,modbus:root('node-red-contrib-modbus/package.json').version,serialFork:root('@openp4nr/modbus-serial/package.json').version,serialport:serialRequire('serialport/package.json').version,binding:bindingRequire('@serialport/bindings-cpp/package.json').version,nativeBinary:binaryPath,nativeBinaryHash:createHash('sha256').update(readFileSync(binaryPath)).digest('hex'),bindingEntryHash:createHash('sha256').update(readFileSync(bindingPath)).digest('hex')}));
 const path=process.argv[2];
 if(path){const port=new SerialPort({path,baudRate:9600,autoOpen:false});port.open(error=>{if(error){console.error(JSON.stringify({event:'PTY_OPEN_FAILED',error:error.message}));process.exitCode=1;return;}console.log(JSON.stringify({event:'PTY_OPENED',path}));port.close();});}
}catch(error){console.error(JSON.stringify({event:'NATIVE_LOAD_FAILED',error:error.message}));process.exitCode=1;}
