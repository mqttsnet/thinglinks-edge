/** Only native transport observations belong here; decoding and Manager delivery errors are excluded by wiring. */
export type ObservedProtocol = 's7' | 'modbus' | 'http-poll' | 'tcp-client' | 'tcp-server' | 'push' | 'opcua' | 'opcua-secure';

const PREFIX = `const status=msg.status;
const text=typeof status==='string'?status:status&&typeof status.text==='string'?status.text:'';
const error=msg.error;
const detail=error&&typeof error.message==='string'?error.message.slice(0,1024):'';
const code=error&&typeof error.code==='string'?error.code:'';
`;
const CONNECTION_ERROR = `if(/\\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND)\\b/.test(code+' '+detail))return {unavailable:'immediate'};`;
const TIMEOUT = `if(/\\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_CONNECT_TIMEOUT)\\b|Timed out|Timeout awaiting/i.test(code+' '+detail))return {unavailable:'candidate',consecutive:PROTOCOL_CONSECUTIVE};`;

// OPC Foundation StatusCode.csv; only errors raised while establishing the session
// prove that this collector cannot communicate. Read permissions and bad individual
// values retain their own quality/error semantics.
const SECURE_SESSION_REJECTION = [
  'BadCertificateInvalid', 'BadSecurityChecksFailed', 'BadCertificatePolicyCheckFailed',
  'BadCertificateTimeInvalid', 'BadCertificateIssuerTimeInvalid', 'BadCertificateHostNameInvalid',
  'BadCertificateUriInvalid', 'BadCertificateUseNotAllowed', 'BadCertificateIssuerUseNotAllowed',
  'BadCertificateUntrusted', 'BadCertificateRevocationUnknown', 'BadCertificateIssuerRevocationUnknown',
  'BadCertificateRevoked', 'BadCertificateIssuerRevoked', 'BadCertificateChainIncomplete',
  'BadUserAccessDenied', 'BadIdentityTokenInvalid', 'BadIdentityTokenRejected',
  'BadSecurityModeRejected', 'BadSecurityPolicyRejected',
].join('|');

const adapters: Record<ObservedProtocol, string> = {
  s7: `${CONNECTION_ERROR}
if(text==='online')return {ready:true};
if(['offline','connecting','verbinde'].includes(text))return {unavailable:'candidate'};`,
  modbus: `${CONNECTION_ERROR}
${TIMEOUT.replace('PROTOCOL_CONSECUTIVE', 'false')}
if(['closed','broken','disconnected','terminated','reconnect'].includes(text)||/^retrying after \\d+ msec\\./.test(text))return {unavailable:'candidate'};
if(['connected','active'].includes(text)||/^active (?:reading|\\()/.test(text))return {ready:true};`,
  'http-poll': `if(Number.isInteger(msg.statusCode)&&msg.statusCode>=100&&msg.statusCode<=599)return {reachable:true};
${CONNECTION_ERROR}
${TIMEOUT.replace('PROTOCOL_CONSECUTIVE', 'true')}`,
  'tcp-client': `${CONNECTION_ERROR}
if(text==='common.status.connected'||text==='connected')return {ready:true};
if(text==='common.status.disconnected'||text==='disconnected')return {unavailable:'immediate'};`,
  'tcp-server': `if(!status||typeof status!=='object'||!status._session||status._session.type!=='tcp'||typeof status._session.id!=='string')return {};
// Node-RED 5.0.4 includes the total connection count in its translated status text.
// Require the native event/session shape as well: arbitrary red labels never imply zero peers.
if(status.event==='connect')return {ready:true};
if(status.event==='disconnect'){
 const count=/^\\D*(\\d+)\\D*$/.exec(text);
 if(count&&Number(count[1])===0)return {unavailable:'immediate',requiresSample:true};
 if(count&&Number(count[1])>0)return {ready:true};
}`,
  push: '',
  opcua: `${CONNECTION_ERROR}
if(['session closed','disconnected','closed','invalid session'].includes(text)||/^reconnect(?:\\s|$)/.test(text))return {unavailable:'candidate'};
if(['session active','connected','keepalive','subscribed','active reading','active multiple reading','active subscribed'].includes(text))return {ready:true};`,
  'opcua-secure': `${CONNECTION_ERROR}
if(/^(?:Error: )?Connect failed: (?:${SECURE_SESSION_REJECTION})$/.test(detail))return {unavailable:'candidate'};
${TIMEOUT.replace('PROTOCOL_CONSECUTIVE', 'false')}
if(/\\b(?:BadConnectionRejected|BadDisconnect|BadConnectionClosed|BadServerNotConnected|BadSessionClosed|BadSecureChannelClosed)\\b/.test(code+' '+detail))return {unavailable:'immediate'};
if(code==='OPCUA_RECONNECTING'||/^OPC UA client is (?:reconnecting|connecting|replacing a failed connection)$/.test(detail))return {unavailable:'candidate'};
if(status&&status.fill==='green'&&/^\\d+ read$/.test(text))return {ready:true};`,
};

export function observationScript(protocol: ObservedProtocol): string {
  return PREFIX + adapters[protocol] + '\nreturn {};';
}
