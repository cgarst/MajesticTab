// urlImport/jobImport.js
// Follows a job a service started and returns the file it made. downloadFromJob shows the progress dialog while it runs;
// followJob is the same without a dialog, for a run that fetches many files and reports its own progress.

import { runJob } from './asyncJob.js';
import { fetchStatus, fetchJobFile } from './openFromUrl.js';
import { showJobProgress } from './jobProgress.js';

/**
 * @param {{first: object, mapping: object, addresses: object, auth: object|null}} job from probeAddress
 * @param {{onProgress?: (update: {state: string, fraction: number|null, label: string}) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<File>}
 * @throws {Error} 'Cancelled.' when aborted, or why the job failed
 */
export async function followJob(job, { onProgress = () => {}, signal } = {}) {
    const { resultUrl } = await runJob({
        first: job.first,
        mapping: job.mapping,
        addresses: job.addresses,
        auth: job.auth,
        fetchJson: fetchStatus,
        onProgress,
        signal
    });
    onProgress({ fraction: null, label: 'Downloading', state: 'running' });
    return fetchJobFile(resultUrl, job.auth);
}

/**
 * @param {{first: object, mapping: object, addresses: object, auth: object|null, title: string}} job from probeAddress
 * @returns {Promise<File>}
 * @throws {Error} 'Cancelled.' when the user cancels, or why the job failed
 */
export async function downloadFromJob(job) {
    const controller = new AbortController();
    const ui = showJobProgress({ title: job.title || 'Fetching a tab', onCancel: () => controller.abort() });
    try {
        return await followJob(job, { onProgress: ui.update, signal: controller.signal });
    } finally {
        ui.close();
    }
}
