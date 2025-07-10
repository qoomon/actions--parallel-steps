import core from "@actions/core";
import {untilStageTrigger} from "./act-interceptor.js";
import fs from "node:fs/promises";

const config = JSON.parse(
    await fs.readFile(core.getInput("config", {required: true}))
        .then((data) => data.toString()),
);
const step = core.getInput('step', {required: true});
const actJobId = core.getInput("act-job-id", {required: true});

if (step === 'Pre') {
    // --- end pre-stage ---
    {
        console.log('__::Interceptor::Pre::End::');
    }

    const stage = 'Main';
    const action = await untilStageTrigger(config.host.tempDir, stage, actJobId);
    if(action === 'skip') {
        process.exit(1); // cancel the job to skip the main stage
    }
    console.log(`__::Interceptor::${stage}::Start::`);
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
