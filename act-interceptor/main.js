import core from "@actions/core";
import {untilStageTrigger} from "./act-interceptor.js";
import fs from "node:fs/promises";

const config = JSON.parse(
    await fs.readFile(core.getInput("config", {required: true}))
        .then((data) => data.toString()),
);
const step = core.getInput('step', {required: true});
const actJobId = core.getInput("act-job-id", {required: true});

core.debug(`Interceptor starting - step: ${step}, jobId: ${actJobId}`);
core.debug(`Temp directory: ${config.host.tempDir}`);
core.debug(`Working directory: ${config.host.workingDirectory}`);

if (step === 'Pre') {
    // --- end pre-stage ---
    {
        console.log('__::Interceptor::Pre::End::');
        core.debug(`Pre stage ended for job ${actJobId}`);
    }

    const stage = 'Main';
    core.debug(`Waiting for ${stage} stage trigger for job ${actJobId}`);
    const action = await untilStageTrigger(config.host.tempDir, stage, actJobId);
    core.debug(`Received stage trigger action: "${action}" for job ${actJobId}`);
    if(action === 'skip') {
        const skipMessage = `Skipping ${stage} stage for job ${actJobId} - this is intentional behavior to cancel the job`;
        core.debug(skipMessage);
        core.setFailed(skipMessage);
        process.exit(1); // cancel the job to skip the main stage
    }
    console.log(`__::Interceptor::${stage}::Start::`);
    core.debug(`${stage} stage started for job ${actJobId}`);
} else if (step === 'Post') {
    const stage = 'Main';
    console.log(`__::Interceptor::${stage}::End::`);

    // --- start post-stage ---
    {
        const stage = 'Post';
        await untilStageTrigger(config.host.tempDir, stage, actJobId);
        console.log(`__::Interceptor::${stage}::Start::`);
    }
} else {
    throw new Error(`Unexpected step: ${step}.`);
}
