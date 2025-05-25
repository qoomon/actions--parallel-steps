import child_process from "node:child_process";
import fs from "node:fs/promises";
import YAML from "yaml";
import path from "node:path";
import {fileURLToPath} from "url";
import os from 'os';
import readline from "node:readline";
import {
    ACTION_STEP_TEMP_DIR,
    colorizeCyan,
    colorizeGray,
    colorizePurple,
    colorizeRed,
    CompletablePromise,
    DEBUG,
    TRACE
} from "./act-interceptor/utils.js";
import core from "@actions/core";
import {EOL} from "node:os";
import TailFile from "@logdna/tail-file";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const actLogFilePath = path.join(ACTION_STEP_TEMP_DIR, 'act.log');
const errorStepsFilePath = path.join(ACTION_STEP_TEMP_DIR, '.error-steps');

export async function run(stage) {
    const githubToken = core.getInput("token", {required: true});
    const steps = getInput("steps", {required: true}, (value) => {
        let steps;
        try {
            steps = YAML.parse(value);
        } catch (e) {
            core.setFailed(`Invalid steps input - Invalid YAML - ${e.message}`);
            process.exit(1);
        }

        if (!Array.isArray(steps)) {
            core.setFailed(`Invalid steps input - Must be an YAML array`);
            process.exit(1);
        }

        if (steps.lenght > os.cpus().length) {
            core.setFailed(`Invalid steps input - Parallel steps are limited to the number of available CPUs (${os.cpus().length})`);
            process.exit(1);
        }

        const stepIds = new Set();
        for (const step of steps) {
            if (step.id !== undefined) {
                if (!String(step.id).match(/^[a-zA-Z_][a-zA-Z0-9_-]{1,100}$/)) {
                    core.setFailed(`Invalid steps input - The identifier '${step.id}' is invalid.` +
                        `IDs may only contain alphanumeric characters, '_', and '-'. IDs must start with a letter or '_' and and must be less than 100 characters.`);
                    process.exit(1);
                }
                if (stepIds.has(step.id)) {
                    core.setFailed(`Invalid steps input - The identifier '${step.id}' may not be used more than once within the same scope.`);
                    process.exit(1);
                }

                stepIds.add(step.id);
            }
        }

        return steps;
    });

    const stagePromise = new CompletablePromise();
    DEBUG && console.log(colorizePurple(`__::Action::${stage}::Start::`));

    if (stage === 'Pre') {
        await startAct(steps, githubToken, actLogFilePath);
        await fs.appendFile(errorStepsFilePath, ''); // ensure the file does exist
    }

    const stepResults = steps.map(() => ({
        status: 'Queued',
        output: '',
        result: null,
        executionTime: null,
        commandFiles: {
            'GITHUB_OUTPUT': {},
            'GITHUB_ENV': {},
            'GITHUB_PATH': [],
            'GITHUB_STEP_SUMMARY': '',
        },
    }));
    await fs.readFile(errorStepsFilePath).then(async (buffer) => {
        const errorSteps = buffer.toString().split('\n').filter((line) => !!line);
        for (const stepIndex of errorSteps) {
            await endStep(stepIndex, 'error');
        }
    })

    let concurrentLogGroupOpen = false

    function concurrentLog(...args) {
        if (!concurrentLogGroupOpen) {
            core.startGroup("Concurrent logs");
            concurrentLogGroupOpen = true;
        }
        console.log(...args);
    }

    // --- tail act log file
    const actLogTail = new TailFile(actLogFilePath, {startPos: stage === 'Pre' ? 0 : null});
    await actLogTail.start();
    readline.createInterface({input: actLogTail, crlfDelay: Infinity})
        .on('line', async (line) => {
            if (stagePromise.status !== 'pending') {
                return;
            }

            if (!line) return;
            TRACE && concurrentLog(colorizeCyan(line));
            line = parseActLine(line);

            if (line.error) {
                const ignore = line.error === 'repository does not exist';
                if (!ignore) {
                    let error = new Error(`${line.error} - ${line.msg}`)
                    if (line.error === 'workflow is not valid') {
                        const workflowStepError = line.msg.match(/Failed to match run-step: Line: (?<line>\d+) Column (?<column>\d+): (?<msg>.*)$/)?.groups;
                        error = new Error(`Invalid steps input - ${workflowStepError?.msg ?? line.msg}`)
                    }
                    stagePromise.reject(error);
                    return;
                }
            }

            if (!line.jobID) return;
            const stepIndex = parseInt(line.jobID.replace(/^\D*/, ''));
            const step = steps[stepIndex];
            const stepId = step.id ?? String(1);
            const stepResult = stepResults[stepIndex];
            if (!stepResult) throw Error(`Unexpected step index: ${stepIndex}`);

            // actual step lines
            if (line.stepID?.[0] === stepId) {
                if (!line.raw_output) {
                    if (line.event === 'Start') {
                        await startStep(stepIndex);
                    } else if (line.command) {
                        // command files
                        switch (line.command) {
                            case 'set-output':
                                stepResult.commandFiles['GITHUB_OUTPUT'][line.name] = line.arg;
                                break;
                            case 'set-env':
                                stepResult.commandFiles['GITHUB_ENV'][line.name] = line.arg;
                                break;
                            case 'add-path':
                                stepResult.commandFiles['GITHUB_PATH'].push(line.arg);
                                break;
                            default:
                                core.warning('Unexpected command: ' + line.msg);
                        }
                    } else if (line.event === 'End') {
                        stepResult.executionTime = line.executionTime;
                        await endStep(stepIndex, line.stepResult);
                    } else if (line.level === 'error') {
                        if (line.msg.startsWith('failed to fetch ')) {
                            const workflowStepError = line.msg.match(/GoGitActionCache (?<msg>failed to fetch \S+ with ref \S+)/)?.groups;
                            const errorMessage = workflowStepError?.msg ?? line.msg;
                            concurrentLog(
                                buildStepLogPrefix() +
                                buildStepIndicator(stepIndex) +
                                '::error::' + errorMessage,
                            );
                            stepResult.output += '::error::' + errorMessage + EOL;
                            await endStep(stepIndex, 'error');
                        }
                    }
                } else {
                    concurrentLog(
                        buildStepLogPrefix() +
                        buildStepIndicator(stepIndex) +
                        line.msg,
                    );
                    stepResult.output += line.msg + EOL;
                }
            } else if (line.jobResult) {
                if (stepResult.status !== 'Completed') {
                    const result = stage !== 'Post' ? 'error' : null;
                    await endStep(stepIndex, result);
                }
            } else if (line.raw_output) {
                const interceptorEvent = line.msg.match(/^__::Interceptor::(?<stage>[^:]+)::(?<type>[^:]+)::(?<value>[^:]*)?/)?.groups;
                if (interceptorEvent) {
                    if (interceptorEvent.stage !== stage) throw Error(`Unexpected stage event: ${line.msg}`);

                    // For some reason, you cannot rely on the act log line order for the post-stage.
                    // Therefore, endStep is called at the end of the job (line.jobResult)
                    if (interceptorEvent.type === 'End' && stepResult.status !== 'Completed' && stage !== 'Post') {
                        await endStep(stepIndex);
                    }
                }
            }
        });

    // --- create the trigger file to signal step runner to start the next stage
    await fs.writeFile(path.join(ACTION_STEP_TEMP_DIR, `.Interceptor-${stage}-Stage`), '');

    await stagePromise
        .finally(() => actLogTail.quit());

    async function startStep(stepIndex) {
        const step = steps[stepIndex];
        const stepResult = stepResults[stepIndex];
        stepResult.status = 'In Progress';

        concurrentLog(
            buildStepLogPrefix('Start') +
            buildStepIndicator(stepIndex) +
            buildStepHeadline(stage, step),
        );
    }

    async function endStep(stepIndex, result) {
        const step = steps[stepIndex];
        const stepResult = stepResults[stepIndex];

        if (stepResult.status === 'Completed') {
            throw new Error(`Unexpected step end. Step was already completed: ${stepIndex}`);
        }

        const previousStatus = stepResult.status;
        stepResult.status = 'Completed';
        if (result) {
            if (result === 'error') {
                await fs.appendFile(errorStepsFilePath, stepIndex + EOL);
            } else if (previousStatus === 'Queued') {
                throw new Error(`Unexpected step result. Step was not running: ${stepIndex}`);
            }
            stepResult.result = result;

        }

        if (previousStatus === 'In Progress') {
            concurrentLog(
                buildStepLogPrefix('End', stepResult.result) +
                buildStepIndicator(stepIndex) +
                buildStepHeadline(stage, step, stepResult),
            );
        }

        // check if the stage has been completed
        if (Object.values(stepResults).every((result) => result.status === 'Completed')) {
            if (concurrentLogGroupOpen) {
                core.endGroup();
            }
            DEBUG && console.log(colorizePurple(`__::Action::${stage}::End::`));

            stepResults.forEach((stepResult, stepIndex) => {
                const step = steps[stepIndex];

                // log aggregated step results
                if (stepResult.result) {
                    console.log('')
                    core.startGroup(' ' +
                        buildStepLogPrefix('End', stepResult.result) +
                        buildStepHeadline(stage, step, stepResult)
                    );
                    console.log(removeTrailingNewLine(stepResult.output));
                    core.endGroup();
                }

                // command files
                Object.entries(stepResult.commandFiles['GITHUB_OUTPUT'])
                    .forEach(([key, value]) => {
                        DEBUG && console.log(`Set output: ${key}=${value}`);
                        core.setOutput(key, value);
                        if (step.id) {
                            const stepKey = step.id + '-' + key;
                            DEBUG && console.log(`Set output: ${stepKey}=${value}`);
                            core.setOutput(stepKey, value);
                        }
                    });
                Object.entries(stepResult.commandFiles['GITHUB_ENV'])
                    .forEach(([key, value]) => {
                        DEBUG && console.log(`Export variable: ${key}=${value}`);
                        core.exportVariable(key, value);
                    });
                stepResult.commandFiles['GITHUB_PATH']
                    .forEach((path) => {
                        DEBUG && console.log(`Add path: ${path}`);
                        core.addPath(path);
                    });
            });

            // complete stage promise
            if (stepResults.every((result) => !result.result || result.result === 'success')) {
                stagePromise.resolve();
            } else {
                stagePromise.reject();
            }
        }
    }
}

async function startAct(steps, githubToken, logFilePath) {
    // Install gh-act extension
    child_process.execSync("gh extension install https://github.com/nektos/gh-act", {
        stdio: 'inherit',
        env: {...process.env, GH_TOKEN: githubToken}
    });

    const ACTION_ENV =Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => {
            return (key.startsWith('GITHUB_') || key.startsWith('RUNNER_'))
                && ![
                    'GITHUB_WORKSPACE',
                    // command files
                    'GITHUB_OUTPUT',
                    'GITHUB_ENV',
                    'GITHUB_PATH',
                    'GITHUB_STEP_SUMMARY',
                    'GITHUB_STATE',
                ].includes(key);
        }));

    console.log(colorizeRed("GITHUB_ACTION:", process.env["GITHUB_ACTION"]))

    const workflow = {
        on: process.env["GITHUB_EVENT_NAME"],
        jobs: {},
    }
    for (const [stepIndex, step] of Object.entries(steps)) {
        const jobId = `Step${stepIndex}`;
        workflow.jobs[jobId] = {
            "runs-on": "host", // refers to gh act parameter "--platform", "host=-self-hosted",
            "steps": [
                {
                    uses: "__/act-interceptor@local",
                    with: {
                        'step': 'Pre',
                        'temp-dir': ACTION_STEP_TEMP_DIR,
                        'host-working-directory': process.cwd(),
                        'host-env': JSON.stringify(ACTION_ENV),
                    }
                },
                step,
                {
                    if: "always()",
                    uses: "__/act-interceptor@local",
                    with: {
                        'step': 'Post',
                        'temp-dir': ACTION_STEP_TEMP_DIR,
                    }
                },
            ],
        };
    }

    const workflowFilePath = path.join(ACTION_STEP_TEMP_DIR, 'steps-workflow.yaml');
    await fs.writeFile(workflowFilePath, YAML.stringify(workflow));

    const actLogFile = await fs.open(logFilePath, 'w');
    child_process.spawn(
        "gh", ["act", "--workflows", workflowFilePath,
            "--bind", // do not copy working directory files
            "--platform", "host=-self-hosted",
            "--local-repository", "__/act-interceptor@local" + "=" + `${__dirname}/act-interceptor`,
            "--eventpath", process.env["GITHUB_EVENT_PATH"],
            "--actor", process.env["GITHUB_ACTOR"],
            "--secret", `GITHUB_TOKEN=${githubToken}`,

            // TODO
            ...Object.entries(ACTION_ENV)
                .map(([key, value]) => ['--env', `${key}=${value}`])
                .flat(),

            "--action-offline-mode",
            "--json",
        ].flat(),
        {
            detached: true,
            stdio: ['ignore', actLogFile, actLogFile],
            env: {...process.env, GH_TOKEN: githubToken},
        }
    ).unref();

}

// --- Utility functions ---

function getInput(name, options, fn) {
    const value = core.getInput(name, options);
    return fn(value);
}

function parseActLine(line) {
    let result = {
        level: 'error',
        error: line,
        msg: '',
    };

    try {
        result = JSON.parse(line);
    } catch (error) {
        const lineMatch = line.match(/^level=(?<level>[\w-]+)\smsg=(?<msg>.*)/);
        if (lineMatch) {
            result = {
                level: lineMatch.groups.level,
                msg: lineMatch.groups.msg,
            };
        } else {
            const error = line.match(/^Error: (?<error>.*)\. (?<msg>.*)/)?.groups;
            if (error) {
                result = {
                    level: 'error',
                    error: error.error,
                    msg: error.msg,
                };

                const msgMatch = error.msg.match(/(?<msg>.*)for job:(?<jobID>\w+) step:(?<step>\d+)$/);
                if (msgMatch) {
                    result = {
                        level: 'error',
                        error: error.error,
                        msg: msgMatch.groups.msg,
                        jobID: msgMatch.groups.jobID,
                        step: [msgMatch.groups.step],
                    };
                }
            }
        }
    }

    // normalize level to github core log levels
    if (result.level === 'warn') result.level = 'warning';

    result.msg = result.msg.trimEnd();

    if (!result.raw_output) {
        if (result.msg.startsWith('⭐ Run ')) {
            result.event = 'Start';
        } else if (result.stepResult || result.jobResult) {
            result.event = 'End';
        } else if (result.msg.startsWith('  ⚙  ::')) {
            // command files
            const command = result.msg.match(/^ {2}⚙ {2}::(?<command>[^:]+)::\s+(?:(?<name>\w+)=)?(?<arg>.*)$/).groups;
            if (!command) {
                throw new Error(`Unexpected command line: ${line.msg}`);
            }
            result.command = command.command;
            result.name = command.name;
            result.arg = command.arg;
            // TODO summary
        }
    }

    return result;
}

function removeTrailingNewLine(text) {
    return text.replace(/\n$/, '');
}

function buildStepHeadline(actStage, step, jobResult = null) {
    let groupHeadline = '';

    if (actStage !== 'Main') {
        groupHeadline += `${actStage} `;
    }

    groupHeadline += `Run ${buildStepDisplayName(step)}`;

    if (jobResult?.executionTime) {
        groupHeadline += colorizeGray(` [${formatMilliseconds(jobResult.executionTime / 1_000_000)}]`);
    }

    return groupHeadline;
}

function buildStepLogPrefix(event, stepResult) {
    if (event === 'Start') {
        return colorizeGray('❯  ');
    }
    if (event === 'Log' || !event) {
        return colorizeGray('   ');
    }
    if (event === 'End') {
        // no job result indicates the step action has no stage implementation
        if (!stepResult || stepResult === 'success') {
            return colorizeGray('⬤ ');
        }
        return colorizeRed('⬤ ');
    }
}

function buildStepIndicator(stepIndex) {
    return colorizeGray(`[${stepIndex}] `);
}

function buildStepDisplayName(step) {
    let displayName = 'INVALID STEP';

    if (step.name) {
        displayName = step.name;
    } else if (step.uses) {
        displayName = step.uses;
    } else if (step.run) {
        displayName = step.run.split('\n')[0];
    }

    return displayName;
}

function formatMilliseconds(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);

    const parts = [];
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0) {
        parts.push(`${minutes}m`);
    }

    parts.push(`${seconds}s`);

    return parts.join(" ");
}