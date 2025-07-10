import core from "@actions/core";
import {untilFilePresent} from "./utils.js";
import path from "node:path";

const step = core.getInput('step', {required: true});
const tempDir = core.getInput("temp-dir", {required: true});
const actJobId = core.getInput("act-job-id", {required: true});

if (step === 'Pre') {
    // --- end pre-stage ---
    {
        console.log('__::Interceptor::Pre::End::');
    }

    const stage = 'Main';
    await untilFilePresent(path.join(tempDir, `.Interceptor-Stage-${stage}-Start-${actJobId}`));
    console.log(`__::Interceptor::${stage}::Start::`);
} else if (step === 'Post') {
    const stage = 'Main';
    console.log(`__::Interceptor::${stage}::End::`);

    // --- start post-stage ---
    {
        const stage = 'Post';
        await untilFilePresent(path.join(tempDir, `.Interceptor-Stage-${stage}-Start-${actJobId}`));
        console.log(`__::Interceptor::${stage}::Start::`);
    }
} else {
    throw new Error(`Unexpected step: ${step}.`);
}
