const {test}=require('node:test');const assert=require('node:assert/strict');const {validatedBindingArtifact}=require('./artifact.cjs');
test('export uses the actual Modbus-owned 10.8 artifact and rejects a top-level 13 binding',()=>{
 const info={event:'NATIVE_LOADED',modbus:'5.60.2',serialFork:'8.4.0',serialport:'10.5.0',binding:'10.8.0',nativeBinary:'/data/runtime/node_modules/@openp4nr/modbus-serial/node_modules/@serialport/bindings-cpp/build/Release/bindings.node',nativeBinaryHash:'a'.repeat(64)};
 assert.equal(validatedBindingArtifact(info),info.nativeBinary);
 assert.throws(()=>validatedBindingArtifact({...info,binding:'13.0.0',nativeBinary:'/data/runtime/node_modules/@serialport/bindings-cpp/build/Release/bindings.node'}));
});
