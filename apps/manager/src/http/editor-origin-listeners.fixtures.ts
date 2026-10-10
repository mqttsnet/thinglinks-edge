import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';

/** Tests keep the actual listener sockets; a free-port probe cannot reserve an origin. */
export async function reserveEditorOriginListeners(count: number): Promise<{
  portRange: { min: number; max: number };
  forwardTo(app: FastifyInstance): Promise<void>;
  close(): Promise<void>;
}> {
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Invalid fixture listener count');
  for (let attempt = 0; attempt < 32; attempt++) {
    const servers: Server[] = [];
    const sockets = new Set<Socket>();
    const routing: { app?: FastifyInstance } = {};
    const close = async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    };
    const bind = async (port: number) => {
      const server = createServer((req, reply) => {
        if (routing.app) routing.app.server.emit('request', req, reply);
        else { req.resume(); reply.writeHead(503); reply.end(); }
      });
      servers.push(server);
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      server.on('upgrade', (req, socket, head) => {
        if (routing.app) routing.app.server.emit('upgrade', req, socket, head);
        else socket.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture listener has no bound port');
      return address.port;
    };
    try {
      const first = await bind(0);
      if (first + count - 1 > 65535) { await close(); continue; }
      // Adjacent ports must really be bound now; merely calculating first + 1
      // can select a port occupied by another test or an outgoing client socket.
      for (let offset = 1; offset < count; offset++) await bind(first + offset);
      return {
        portRange: { min: first, max: first + count - 1 },
        forwardTo: async app => { await app.ready(); routing.app = app; },
        close,
      };
    } catch (error) {
      await close();
      // Retry only while reserving this test's unadvertised sockets. The product
      // startup function continues to report a configured-port collision.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Unable to reserve adjacent editor fixture listeners');
}
