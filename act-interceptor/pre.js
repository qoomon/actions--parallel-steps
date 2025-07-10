import core from '@actions/core';
import fs from "node:fs/promises";
import {untilStageTrigger} from "./act-interceptor.js";

const config = JSON.parse(
    await fs.readFile(core.getInput("config", {required: true}))
        .then((data) => data.toString()),
);
const step = core.getInput('step', {required: true});
const actJobId = core.getInput("act-job-id", {required: true});

if (step === 'Pre') {
    // set host environment variables
    Object.entries(config.host.env).forEach(([name, val]) => {
        core.exportVariable(name, val);
    });

    // --- Link job working directory to host working directory
    const jobWorkingDirectory = process.cwd();
    await fs.rm(jobWorkingDirectory, {recursive: true});
    await fs.symlink(config.host.workingDirectory, jobWorkingDirectory);

    const stage = 'Pre';
    await untilStageTrigger(config.host.tempDir, stage, actJobId);
    console.log(`__::Interceptor::${stage}::Start::`);
}