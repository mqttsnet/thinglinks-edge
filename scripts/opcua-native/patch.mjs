import {Buffer} from 'node:buffer';
/** Chain identity adaptation from open62541 v1.5.8 to the 1.4 SecurityPolicy ABI.
 * Full-chain trust/CRL verification remains in unpackPayloadOPN; nonce signatures
 * and receiver thumbprints remain unchanged. See README.md for provenance. */
import {createHash} from 'node:crypto';
export const SOURCE_SHA256='60eb5e5c9c1bc579ca923abef2b83806c279542fc9ef007796b5800b3c2da28b';
export function applyChainFix(bytes){
 if(createHash('sha256').update(bytes).digest('hex')!==SOURCE_SHA256)throw Error('Unexpected open62541 source digest; refusing patch');
 let source=bytes.toString('utf8').replaceAll('\r\n','\n');
 const oldSession=`        if(!UA_ByteString_equal(&sessionResponse->serverCertificate,
                                &client->channel.remoteCertificate)) {`;
 const newSession=`        if(client->channel.securityPolicy->channelModule.compareCertificate(
               client->channel.channelContext, &sessionResponse->serverCertificate)
           != UA_STATUSCODE_GOOD) {`;
 const oldHeader=`    /* Get the remote certificate.
     * Omit the remainder if an entire certificate chain was sent. */
    UA_ByteString serverCert = getLeafCertificate(asymHeader->senderCertificate);

    /* If encryption is enabled, then a server certificate is defined.
     * Otherwise the creation of the SecureChannel would have failed. */
    UA_assert(channel->securityMode == UA_MESSAGESECURITYMODE_NONE ||
              serverCert.length > 0);

    /* If a server certificate is sent in the asymHeader, check that the same
     * certificate was defined for the endpoint */
    if(serverCert.length > 0 &&
       !UA_String_equal(&serverCert, &client->endpoint.serverCertificate)) {`;
 const newHeader=`    /* The SecurityPolicy context holds the selected endpoint's certificate.
     * Compare its X.509 leaf identity with the OPN certificate, allowing full or
     * partial DER chains (OPC 10000-6 6.2.6). Full-chain verification already
     * succeeded in unpackPayloadOPN; this does not change trust or revocation. */
    if(channel->securityMode != UA_MESSAGESECURITYMODE_NONE &&
       sp->channelModule.compareCertificate(
           channel->channelContext, &asymHeader->senderCertificate) != UA_STATUSCODE_GOOD) {`;
 for(const [before,after] of [[oldSession,newSession],[oldHeader,newHeader]]){
  if(source.split(before).length!==2)throw Error('Unexpected patch context');source=source.replace(before,after);
 }
 return Buffer.from(source.replaceAll('\n','\r\n'));
}
