import path from "node:path";
import fs from "node:fs";
import core from "@actions/core";

function buildActInterceptorStageFilePath(tempDir, stage, actJobId) {
    return path.join(tempDir, `.Interceptor-Stage-${stage}-Start-${actJobId}`);
}

export async function untilStageTrigger(tempDir, stage, actJobId, timeoutMs = 30000) {
    const filePath = buildActInterceptorStageFilePath(tempDir, stage, actJobId);
    const dirname = path.dirname(filePath);
    const basename = path.basename(filePath);
    if (!basename) throw new Error("Invalid file path: " + filePath);

    core.debug(`Waiting for stage trigger file: ${filePath}`);
    
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout waiting for stage trigger file: ${filePath}`)), timeoutMs);
    });
    
    const watcherPromise = (async () => {
        const watcher = fs.promises.watch(dirname);
        try {
            await fs.promises.access(filePath);
            core.debug(`Stage trigger file already exists: ${filePath}`);
        } catch (e) {
            core.debug(`Watching for stage trigger file creation: ${filePath}`);
            for await (const {eventType, filename} of watcher) {
                core.debug(`File system event: ${eventType} for ${filename}`);
                if (filename === basename && eventType === 'rename') {
                    core.debug(`Stage trigger file created: ${filePath}`);
                    break;
                }
            }
        } finally {
            try {
                await watcher.return();
            } catch (error) {
                core.debug(`Error closing file watcher: ${error.message}`);
            }
        }
    })();

    try {
        await Promise.race([watcherPromise, timeoutPromise]);
    } catch (error) {
        core.error(`Error waiting for stage trigger: ${error.message}`);
        throw error;
    }

    try {
        const content = fs.readFileSync(filePath).toString() || 'continue';
        core.debug(`Stage trigger content: "${content}"`);
        return content;
    } catch (error) {
        core.error(`Failed to read stage trigger file ${filePath}: ${error.message}`);
        throw new Error(`Failed to read stage trigger file: ${error.message}`);
    }
}

export async function triggerStage(tempDir, stage, actJobId, message = 'continue') {
    const filePath = buildActInterceptorStageFilePath(tempDir, stage, actJobId);
    core.debug(`Triggering stage ${stage} for job ${actJobId} with message: "${message}"`);
    try {
        await fs.promises.writeFile(filePath, message);
        core.debug(`Successfully created stage trigger file: ${filePath}`);
    } catch (error) {
        core.error(`Failed to create stage trigger file ${filePath}: ${error.message}`);
        throw new Error(`Failed to create stage trigger file: ${error.message}`);
    }
}
