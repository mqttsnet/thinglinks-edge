import type { IncomingHttpHeaders } from 'node:http';

/** The proxy authenticates the Manager session before removing it at this boundary. */
export function instanceRequestHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const clean = { ...headers };
  for (const name of Object.keys(clean)) {
    const key = name.toLowerCase();
    if (key === 'cookie' || key === 'cookie2' || key === 'x-csrf-token'
      || key === 'forwarded' || key === 'x-real-ip' || key === 'remote-user'
      || key === 'x-remote-user' || key === 'x-authenticated-user'
      || key.startsWith('x-forwarded-') || key.startsWith('x-auth-request-')
      || key.startsWith('x-tle-') || key.startsWith('x-thinglinks-')) delete clean[name];
  }
  // Explicit Authorization and application headers belong to this request's target.
  // Cookies have no origin/path provenance once sent by the browser, so forwarding
  // selected names cannot distinguish another instance's cookie from a flow cookie.
  return clean;
}

/** A same-origin instance must never overwrite Manager or another instance's cookies. */
export function instanceResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const clean = { ...headers };
  for (const name of Object.keys(clean)) {
    const key = name.toLowerCase();
    if (key === 'set-cookie' || key === 'set-cookie2' || key === 'clear-site-data'
      || key === 'service-worker-allowed') delete clean[name];
  }
  return clean;
}
