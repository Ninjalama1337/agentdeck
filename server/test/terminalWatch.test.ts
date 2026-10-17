/**
 * Real socket.io round trip: `terminal:data` reaches only the sockets that
 * watch the terminal — and every terminal for a socket that never sent a
 * watch list (older apps).
 */
import http from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { attachGateway, type DeckIo } from '../src/ws/gateway.js';
import { ioTerminalStream } from '../src/ws/termStream.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import type { Logger } from '../src/logging.js';

const SECRET = 'ab'.repeat(32);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: http.Server;
let io: DeckIo;
let url = '';
let token = '';
const clients: Socket[] = [];

beforeAll(async () => {
  server = http.createServer();
  io = attachGateway({
    httpServer: server,
    secretHex: SECRET,
    logger: { debug: () => undefined } as unknown as Logger,
    manager: {} as never,
    terminals: {} as never,
    touchDevice: async () => undefined,
    corsOrigins: [],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  token = await signDeviceToken(SECRET, { deviceId: 'phone', name: 'Phone' });
});

afterAll(async () => {
  for (const c of clients) c.close();
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

async function client(): Promise<{ socket: Socket; got: string[] }> {
  const socket = connect(url, { auth: { token }, transports: ['websocket'] });
  clients.push(socket);
  const got: string[] = [];
  socket.on('terminal:data', ({ id, data }: { id: string; data: string }) => got.push(`${id}:${data}`));
  await new Promise((resolve) => socket.on('connect', () => resolve(undefined)));
  return { socket, got };
}

it('streams a terminal only to the devices watching it', async () => {
  const legacy = await client();
  const phone = await client();
  phone.socket.emit('terminal:watch', { ids: ['b'] });
  await sleep(50);

  const stream = ioTerminalStream(io);
  const bulk = 'x'.repeat(3000); // over the deflate threshold
  stream.data('a', bulk);
  stream.data('b', 'hi');
  stream.data('b', '!');
  await sleep(100);

  expect(legacy.got.sort()).toEqual([`a:${bulk}`, 'b:hi!']);
  expect(phone.got).toEqual(['b:hi!']);

  phone.socket.emit('terminal:watch', { ids: [] });
  await sleep(50);
  stream.data('b', 'gone');
  await sleep(100);
  expect(phone.got).toEqual(['b:hi!']);
});
