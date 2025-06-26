import core, {ExitCode} from "@actions/core";
import {installDependencies, run} from "./steps-runner.js";

await installDependencies().catch((error) => {
    process.exitCode = ExitCode.Failure;
    if (error?.message) {
        core.setFailed(error.message);
    }
});

await run('Pre').catch((error) => {
    process.exitCode = ExitCode.Failure;
    if (error?.message) {
        core.setFailed(error.message);
    }
});

console.log('');

await run('Main').catch((error) => {
    process.exitCode = ExitCode.Failure;
    if (error?.message) {
        core.setFailed(error.message);
    }
});