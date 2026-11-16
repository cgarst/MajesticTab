// Starts the fake S3 server with CORS for the browser tests and prints its endpoint. Stops when stdin closes.
import { startFakeS3 } from './fakeS3Server.mjs';
const server = await startFakeS3({ cors: true, pageSize: 100, port: Number(process.argv[2]) || 0 });
console.log(server.endpoint);
process.stdin.resume();
process.stdin.on('end', () => server.close().then(() => process.exit(0)));
