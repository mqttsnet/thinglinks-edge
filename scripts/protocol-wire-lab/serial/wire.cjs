/* global Buffer */
function crc16(bytes) { let crc=0xffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xa001:crc>>>1;}return crc; }
function describeFrame(bytes) { return {hex:bytes.toString('hex'),length:bytes.length,unit:bytes[0],functionCode:bytes[1],crcValid:bytes.length>=4&&crc16(bytes.subarray(0,-2))===bytes.readUInt16LE(bytes.length-2)}; }
function corruptResponse(bytes,mode) {
 const copy=Buffer.from(bytes);
 if(mode==='bad-crc')copy[copy.length-1]^=1;
 else if(mode==='wrong-unit'){copy[0]=2;copy.writeUInt16LE(crc16(copy.subarray(0,-2)),copy.length-2);}
 else if(mode==='truncated')return copy.subarray(0,-2);
 return copy;
}
module.exports={crc16,describeFrame,corruptResponse};
