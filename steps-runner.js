import child_process from "node:child_process";
import fs from "node:fs/promises";
import YAML from "yaml";
import path from "node:path";
import {fileURLToPath} from "url";
import os from 'os';
import readline from "node:readline";
import {
    ACTION_STEP_TEMP_DIR,
    colorizeBlue,
    colorizeCyan,
    colorizeGray,
    colorizePurple,
    colorizeRed,
    colorizeYellow,
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

const ACTION_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    return (key.startsWith('GITHUB_') || key.startsWith('RUNNER_'))
        && ![
            'RUNNER_TEMP', // TODO
            'GITHUB_WORKSPACE',
            // command files
            'GITHUB_OUTPUT',
            'GITHUB_ENV',
            'GITHUB_PATH',
            'GITHUB_STEP_SUMMARY',
            'GITHUB_STATE',
        ].includes(key);
}));

export const GH_ACT_VERSION = '0.2.79';

export async function run(stage) {
    const githubToken = core.getInput("token", {required: true});
    const steps = getInput("steps", {required: true}, (value) => {
        /** @type {Array<{
         * id?: string,
         * name?: string,
         * }>} */
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

        if (steps.length > os.cpus().length) {
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

    const stepResults = steps.map(() => ({
        status: 'Queued',
        output: '',
        outputGroup: false,
        result: null,
        executionTime: null,
        commandFiles: {
            'GITHUB_OUTPUT': {},
            'GITHUB_ENV': {},
            'GITHUB_PATH': [],
            'GITHUB_STEP_SUMMARY': [],
        },
        secrets: [],
    }));

    if (stage === 'Pre') {
        await fs.writeFile(actLogFilePath, '');

        await startAct(steps, githubToken, actLogFilePath);
    } else {
        const skipped = !await fs.access(actLogFilePath).then(() => true).catch(() => false);
        if (skipped) {
            core.debug(`Skipping ${stage} stage`);
            return;
        }

        await fs.appendFile(errorStepsFilePath, ''); // ensure the error steps file exists
        const errorStepsFileContent = await fs.readFile(errorStepsFilePath).then((buffer) => buffer.toString());
        const errorSteps = errorStepsFileContent.split('\n').filter((line) => !!line);
        for (const stepIndex of errorSteps) {
            await endStep(stepIndex, 'error');
        }
    }

    const stagePromise = new CompletablePromise();
    DEBUG && console.log(colorizePurple(`__::Act::${stage}::Start::`));

    let concurrentLogGroup = false

    function concurrentLog(...args) {
        if (!concurrentLogGroup) {
            core.startGroup("Concurrent logs");
            concurrentLogGroup = true;
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
                            case 'group': {
                                const msg = `▼ ${line.arg}`;
                                concurrentLog(
                                    buildStepLogPrefix() +
                                    buildStepIndicator(stepIndex) +
                                    msg,
                                );
                                stepResult.output += msg + EOL;
                                stepResult.outputGroup = true
                                break;
                            }
                            case 'endgroup':
                                stepResult.outputGroup = false
                                break;

                            case 'add-matcher':
                            case 'remove-matcher':
                                stepResult.output += line.raw + EOL;
                                break;

                            case 'set-output':
                                stepResult.commandFiles['GITHUB_OUTPUT'][line.name] = line.arg;
                                break;
                            case 'set-env':
                                // skip GITHUB_ENV variables that are passed to and set by the interceptor action, see startAct()
                                if (!Object.keys(ACTION_ENV).includes(line.arg)) {
                                    stepResult.commandFiles['GITHUB_ENV'][line.name] = line.arg;
                                }
                                break;
                            case 'add-path':
                                stepResult.commandFiles['GITHUB_PATH'].push(line.arg);
                                break;
                            case 'summary':
                                stepResult.commandFiles['GITHUB_STEP_SUMMARY'].push(line.content);
                                break;
                            case 'add-mask':
                                stepResult.secrets.push(line.arg);
                                break;

                            case 'warning':
                            case 'error':
                            case 'debug': {
                                let concurrentLogMsg = line.raw.replace(/^::[^:]+::/, '');
                                switch (line.command) {
                                    case 'warning':
                                        concurrentLogMsg = colorizeYellow(concurrentLogMsg);
                                        break;
                                    case 'error':
                                        concurrentLogMsg = colorizeRed(concurrentLogMsg);
                                        break;
                                    case 'debug':
                                        concurrentLogMsg = colorizeGray(concurrentLogMsg);
                                        break;
                                }
                                concurrentLog(
                                    buildStepLogPrefix() +
                                    buildStepIndicator(stepIndex) +
                                    (stepResult.outputGroup ? `  ${concurrentLogMsg}` : concurrentLogMsg),
                                );

                                stepResult.output += (stepResult.outputGroup
                                    ? line.raw.replace(/(::[^:]+::)/, '$1  ')
                                    : line.raw) + EOL;
                                break;
                            }

                            default:
                                core.warning('Unsupported command: ' + line.command);
                                concurrentLog(
                                    buildStepLogPrefix() +
                                    buildStepIndicator(stepIndex) +
                                    line.raw,
                                );
                                stepResult.output += line.raw + EOL;
                        }
                    } else if (line.event === 'End') {
                        stepResult.executionTime = line.executionTime;
                        stepResult.result = line.stepResult;
                        // endStep(...) is called at __::interceptor:: end event
                    } else if (line.level === 'error') {
                        if (line.msg.startsWith('failed to fetch ')) {
                            const workflowStepError = line.msg.match(/GoGitActionCache (?<msg>failed to fetch \S+ with ref \S+)/)?.groups;
                            const errorMessage = workflowStepError?.msg ?? line.msg;
                            concurrentLog(
                                buildStepLogPrefix() +
                                buildStepIndicator(stepIndex) +
                                (stepResult.outputGroup ? `  ${colorizeRed(errorMessage)}` : colorizeRed(errorMessage)),
                            );
                            stepResult.output += '::error::' + (stepResult.outputGroup ? `  ${errorMessage}` : errorMessage) + EOL;
                            await endStep(stepIndex, 'error');
                        }
                    }
                } else {
                    // raw output lines
                    let concurrentLogMsg = line.msg;
                    if (concurrentLogMsg.startsWith('[command]')) {
                        concurrentLogMsg = concurrentLogMsg.replace(/^\[command]/, '');
                        concurrentLogMsg = colorizeBlue(concurrentLogMsg);
                    }
                    concurrentLog(
                        buildStepLogPrefix() +
                        buildStepIndicator(stepIndex) +
                        (stepResult.outputGroup ? `  ${concurrentLogMsg}` : concurrentLogMsg),
                    );

                    let outputMsg = line.msg;
                    if (outputMsg.startsWith('[command]')) {
                        outputMsg = colorizeBlue(outputMsg.replace(/^\[command]/, ''));
                    }
                    stepResult.output += (stepResult.outputGroup ? `  ${outputMsg}` : outputMsg) + EOL;
                }
            } else if (line.raw_output) {
                const interceptorEvent = line.msg.match(/^__::Interceptor::(?<stage>[^:]+)::(?<type>[^:]+)::(?<value>[^:]*)?/)?.groups;
                if (interceptorEvent) {
                    // For some reason, you cannot rely on the act log line order for the post-stage.
                    // Therefore, endStep is called at the end of the job (line.jobResult, see below)
                    if (interceptorEvent.type === 'End' && stage !== 'Post') {
                        await endStep(stepIndex);
                    }
                }
            } else if (line.jobResult) {
                if (stepResult.status !== 'Completed') {
                    const result = stage !== 'Post' ? 'error' : null;
                    await endStep(stepIndex, result);
                }
            }
        });

    // --- create the trigger file to signal step runner to start the next stage
    await fs.writeFile(path.join(ACTION_STEP_TEMP_DIR, `.Interceptor-${stage}-Stage`), '');

    await stagePromise
        .finally(() => actLogTail.quit());
    if (stage === 'Post') {
        const actPid = parseInt(core.getState('act-pid'));
        try {
            process.kill(actPid)
        } catch (error) {
        }
    }

    async function startStep(stepIndex) {
        const step = steps[stepIndex];
        const stepResult = stepResults[stepIndex];
        stepResult.status = 'In Progress';

        DEBUG && console.log(buildStepLogPrefix() +
            buildStepIndicator(stepIndex) +
            colorizeBlue(`__::Step::${stage}::Start::`)
        );
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
            DEBUG && console.log(buildStepLogPrefix() +
                buildStepIndicator(stepIndex) +
                colorizeBlue(`__::Step::${stage}::End::`)
            );
        }

        // check if the stage has been completed
        if (Object.values(stepResults).every((result) => result.status === 'Completed')) {
            if (concurrentLogGroup) {
                core.endGroup();
                console.log('');
            }
            DEBUG && console.log(colorizePurple(`__::Act::${stage}::End::`));

            stepResults.forEach((stepResult, stepIndex) => {
                const step = steps[stepIndex];

                // log aggregated step results
                if (stepResult.result) {
                    core.startGroup(' ' +
                        buildStepLogPrefix('End', stepResult.result) +
                        buildStepHeadline(stage, step, stepResult)
                    );
                    console.log(removeTrailingNewLine(stepResult.output));
                    core.endGroup();
                    console.log('')
                }

                // command files
                Object.entries(stepResult.commandFiles['GITHUB_OUTPUT']).forEach(([key, value]) => {
                    DEBUG && console.log(`Set output: ${key}=${value}`);
                    core.setOutput(key, value);
                    if (step.id) {
                        const stepKey = step.id + '--' + key;
                        DEBUG && console.log(`Set output: ${stepKey}=${value}`);
                        core.setOutput(stepKey, value);
                    }
                });
                Object.entries(stepResult.commandFiles['GITHUB_ENV']).forEach(([key, value]) => {
                    DEBUG && console.log(`Set env: ${key}=${value}`);
                    core.exportVariable(key, value);
                });
                stepResult.commandFiles['GITHUB_PATH'].forEach((path) => {
                    DEBUG && console.log(`Add path: ${path}`);
                    core.addPath(path);
                });
                stepResult.commandFiles['GITHUB_STEP_SUMMARY'].forEach((summary) => {
                    DEBUG && console.log(`Step summary: ${summary}`);
                    core.summary.addRaw(summary, true).write();
                });

                stepResult.secrets.forEach((secret) => {
                    DEBUG && console.log(`Add mask: ***`);
                    core.setSecret(secret);
                });
            });

            // complete stage promise
            if (stepResults.every((result) => result.result === 'success' || !result.result)) {
                stagePromise.resolve();
            } else {
                stagePromise.reject();
            }
        }
    }
}

async function startAct(steps, githubToken, logFilePath) {
    const workflow = {
        on: process.env["GITHUB_EVENT_NAME"],
        jobs: Object.assign({}, ...Object.entries(steps)
            // Make a deep copy of the step to avoid modifying the input steps
            .map(([stepIndex, step]) => [stepIndex, JSON.parse(JSON.stringify(step))])
            .map(([stepIndex, step]) => ({
                [`Step${stepIndex}`]: {
                    "runs-on": "host", // refers to gh act parameter "--platform", "host=-self-hosted",
                    "steps": [
                        {
                            uses: "__/act-interceptor@local",
                            with: {
                                'step': 'Pre',
                                'temp-dir': ACTION_STEP_TEMP_DIR,
                                'host-working-directory': process.cwd(),
                                'host-env': JSON.stringify(ACTION_ENV),
                            },
                        },
                        Object.assign(step, {
                            env: Object.assign(step.env ?? {}, {
                                // WORKAROUND
                                // GITHUB_ACTION cant be overwritten by act --env nor by core.exportVariable of the interceptor pre-step,
                                // therefore a workaround we need to set it as an environment variable of the step itself.
                                "GITHUB_ACTION": (process.env["X_GITHUB_ACTION"] ?? process.env["GITHUB_ACTION"]) + `__step_${stepIndex}`,
                                "X_GITHUB_ACTION": (process.env["X_GITHUB_ACTION"] ?? process.env["GITHUB_ACTION"]) + `__step_${stepIndex}`,
                            }),
                        }),
                        {
                            if: "always()",
                            uses: "__/act-interceptor@local",
                            with: {
                                'step': 'Post',
                                'temp-dir': ACTION_STEP_TEMP_DIR,
                            },
                        },
                    ],
                }
            }))),
    }

    const workflowFilePath = path.join(ACTION_STEP_TEMP_DIR, 'steps-workflow.yaml');
    await fs.writeFile(workflowFilePath, YAML.stringify(workflow));

    const actLogFile = await fs.open(logFilePath, 'w');
    // noinspection JSCheckFunctionSignatures
    const actProcess = child_process.spawn(
        "gh", ["act", "--workflows", workflowFilePath,
            "--concurrent-jobs", steps.length,
            "--bind", // do not copy working directory files
            "--platform", "host=-self-hosted",
            "--local-repository", "__/act-interceptor@local" + "=" + `${__dirname}/act-interceptor`,
            "--eventpath", process.env["GITHUB_EVENT_PATH"],
            "--actor", process.env["GITHUB_ACTOR"],
            "--secret", `GITHUB_TOKEN=${githubToken}`,
            "--no-skip-checkout",

            // TODO chek if needed
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
        },
    );
    actProcess.unref();
    await actLogFile.close();
    return actProcess.pid;
}

// --- Utility functions ---

function getInput(name, options, fn) {
    const value = core.getInput(name, options);
    return fn(value);
}

/**
 * Parses a line from the act log file.
 * @param line {string} The line to parse.
 */
function parseActLine(line) {
    /** @type {{
     event: string,
     level: string,
     msg: string,
     raw?: string,
     error?: string,
     jobID?: string,
     jobResult?: string,
     stepID?: string,
     stepResult?: string,
     raw_output?: string,
     executionTime?: number,
     command?: string,
     arg?: string,
     name?: string,
     content?: string,
     }} */
    let result = {
        event: 'Log',
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
                event: 'Log',
                level: lineMatch.groups.level,
                msg: lineMatch.groups.msg,
            };
        } else {
            const error = line.match(/^Error: (?<error>.*)\. (?<msg>.*)/)?.groups;
            if (error) {
                result = {
                    event: 'Log',
                    level: 'error',
                    error: error.error,
                    msg: error.msg,
                };

                const msgMatch = error.msg.match(/(?<msg>.*)for job:(?<jobID>\w+) step:(?<step>\d+)$/);
                if (msgMatch) {
                    result = {
                        event: 'Log',
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

    if (result.command) {
        result.event = 'Command';
    } else if (!result.raw_output) {
        if (result.msg.startsWith('⭐ Run ')) {
            result.event = 'Start';
        } else if (result.stepResult || result.jobResult) {
            result.event = 'End';
        }
    }

    // normalize level to github core log levels
    if (result.level === 'warn') result.level = 'warning';

    result.msg = result.msg.trimEnd();
    if (result.raw) {
        result.raw = result.raw.replace(/\n$/, '');
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
        return colorizeGray('❯ ');
    }
    if (event === 'Log' || !event) {
        return colorizeGray('  ');
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

export async function installDependencies() {
    const githubToken = core.getInput("token", {required: true});
    // Install gh-act extension
    const actVersionTag = `v${GH_ACT_VERSION}`;
    console.log(`Installing gh cli extension nektos/gh-act@${actVersionTag} ...`);
    child_process.execSync(`gh extension install https://github.com/nektos/gh-act --pin ${actVersionTag}`, {
        stdio: 'inherit',
        env: {...process.env, GH_TOKEN: githubToken}
    });
    child_process.execSync("gh act --version", {
        stdio: 'inherit',
    });
}
