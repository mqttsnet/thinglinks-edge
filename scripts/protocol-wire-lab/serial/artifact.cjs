const assert=require('node:assert/strict');
function validatedBindingArtifact(info){
 assert.equal(info.event,'NATIVE_LOADED');assert.equal(info.modbus,'5.60.2');assert.equal(info.serialFork,'8.4.0');assert.equal(info.serialport,'10.5.0');assert.equal(info.binding,'10.8.0');
 assert.match(info.nativeBinary,/^\/data\/runtime\/node_modules\/.+\/build\/Release\/bindings\.node$/);
 assert.equal(info.nativeBinary.includes('/../'),false);assert.match(info.nativeBinaryHash,/^[a-f0-9]{64}$/);
 return info.nativeBinary;
}
module.exports={validatedBindingArtifact};
