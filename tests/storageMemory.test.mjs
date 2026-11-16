// Run with: node --test tests/storageMemory.test.mjs
import { createMemoryStore } from '../src/storage/memoryStore.js';
import { runConformance } from './storage/conformance.mjs';

runConformance('memory store', async () => {
    const s = createMemoryStore();
    await s.open({ create: true });
    return s;
});
