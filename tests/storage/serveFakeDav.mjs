// Starts the fake WebDAV server with CORS for the browser tests and prints its URL. Stops when stdin closes.
import { startFakeDav } from './fakeDavServer.mjs';
const server = await startFakeDav({ cors: true, port: Number(process.argv[2]) || 0 });
console.log(server.url);
process.stdin.resume();
process.stdin.on('end', () => server.close().then(() => process.exit(0)));
