// urlImport/jobImport.js
// Follows a job a service started and returns the file it made, with the progress dialog on screen while it runs.

import { runJob } from './asyncJob.js';
import { fetchStatus, fetchJobFile } from './openFromUrl.js';
import { showJobProgress } from './jobProgress.js';

/**
 * @param {{first: object, mapping: object, addresses: object, auth: object|null, title: string}} job from probeAddress
 * @returns {Promise<File>}
 * @throws {Error} 'Cancelled.' when the user cancels, or why the job failed
 */
export async function downloadFromJob(job) {
    const controller = new AbortController();
    const ui = showJobProgress({ title: job.title || 'Fetching a tab', onCancel: () => controller.abort() });
    try {
        const { resultUrl } = await runJob({
            first: job.first,
            mapping: job.mapping,
            addresses: job.addresses,
            auth: job.auth,
            fetchJson: fetchStatus,
            onProgress: ui.update,
            signal: controller.signal
        });
        ui.update({ fraction: null, label: 'Downloading', state: 'running' });
        return await fetchJobFile(resultUrl, job.auth);
    } finally {
        ui.close();
    }
}
