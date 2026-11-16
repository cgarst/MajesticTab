// Starts the fake Google Drive server for the browser tests and prints its URL. Stops when stdin closes.
import { startFakeDrive } from './fakeDriveServer.mjs';
const server = await startFakeDrive({ pageSize: 100, port: Number(process.argv[2]) || 0 });
console.log(server.url);
process.stdin.resume();
process.stdin.on('end', () => server.close().then(() => process.exit(0)));
