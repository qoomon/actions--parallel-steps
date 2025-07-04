import core, {ExitCode} from "@actions/core";
import {installDependencies, run} from "./steps-runner.js";

await installDependencies()
    .then(() => run('Pre'))
    .then(() => run('Main'))
    .catch((error) => {
        process.exitCode = ExitCode.Failure;
        if (error?.message) {
            core.setFailed(error.message);
        }
    });
