import core from "@actions/core";
import {untilFilePresent} from "./utils.js";
import path from "node:path";

const step = core.getInput('step', {required: true});
const tempDir = core.getInput("temp-dir", {required: true});
const needs = core.getInput("needs", {required: false})?.split(',').filter(it => it) ?? [];

if (step === 'Pre') {
    // --- end pre-stage ---
    {
        console.log('__::Interceptor::Pre::End::');
    }

    const stage = 'Main';
    await untilFilePresent(path.join(tempDir, `.Interceptor-Stage-${stage}-Start`));
    // wait for all prerequisites to finish the main stage
    await Promise.all(needs.map((neededJobId) =>
        untilFilePresent(path.join(tempDir, `.Interceptor-Job-${neededJobId}-Completed`))));

    console.log(`__::Interceptor::${stage}::Start::`);
} else if (step === 'Post') {
    const stage = 'Main';
    console.log(`__::Interceptor::${stage}::End::`);

    // --- start post-stage ---
    {
        const stage = 'Post';
        await untilFilePresent(path.join(tempDir, `.Interceptor-Stage-${stage}-Start`));
        console.log(`__::Interceptor::${stage}::Start::`);
    }
} else {
    throw new Error(`Unexpected step: ${step}.`);
}
