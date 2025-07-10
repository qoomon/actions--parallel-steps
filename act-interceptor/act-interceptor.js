import path from "node:path";
import fs from "node:fs";

function buildActInterceptorStageFilePath(tempDir, stage, actJobId) {
    return path.join(tempDir, `.Interceptor-Stage-${stage}-Start-${actJobId}`);
}

export async function untilStageTrigger(tempDir, stage, actJobId) {
    const filePath = buildActInterceptorStageFilePath(tempDir, stage, actJobId);
    const dirname = path.dirname(filePath);
    const basename = path.basename(filePath);
    if (!basename) throw new Error("Invalid file path: " + filePath);

    const watcher = fs.promises.watch(dirname);
    try {
        await fs.promises.access(filePath);
    } catch (e) {
        for await (const {eventType, filename} of watcher) {
            if (filename === basename && eventType === 'rename') {
                break;
            }
        }
    }

    return fs.readFileSync(filePath).toString() || 'continue';
}

export async function triggerStage(tempDir, stage, actJobId, message = 'continue') {
    const filePath = buildActInterceptorStageFilePath(tempDir, stage, actJobId);
    await fs.promises.writeFile(filePath, message);
}
