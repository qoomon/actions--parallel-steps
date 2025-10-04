import child_process from "node:child_process";
import fs from "node:fs/promises";
import YAML from "yaml";
import path from "node:path";
import {fileURLToPath} from "url";
import readline from "node:readline";
import {ACTION_STEP_TEMP_DIR, colorize, CompletablePromise, TRACE} from "./act-interceptor/utils.js";
import core from "@actions/core";
import {EOL} from "node:os";
import TailFile from "@logdna/tail-file";
import * as actInterceptor from "./act-interceptor/act-interceptor.js";

export const GH_ACT_VERSION = '0.2.82';

const ACTION_ENV = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => {
        return (key.startsWith('GITHUB_') || key.startsWith('RUNNER_')) && ![
            'RUNNER_TEMP', // TODO
            // command files
            'GITHUB_OUTPUT',
            'GITHUB_ENV',
            'GITHUB_PATH',
            'GITHUB_STEP_SUMMARY',
            'GITHUB_STATE',
        ].includes(key);
    }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const actLogFilePath = path.join(ACTION_STEP_TEMP_DIR, 'act.log');
const errorStepsFilePath = path.join(ACTION_STEP_TEMP_DIR, '.error-steps');

const inputs = {
    githubToken: core.getInput("token", {required: true}),
    /** @type {Array<{
     *   id?: string,
     *   name?: string,
     *   needs?: Array<string|number>,
     * }>} */
    steps: getInput("steps", {required: true}, (value) => {
        let steps;
        try {
            steps = YAML.parse(value);
        } catch (e) {
            throw new Error(`Invalid steps input - Invalid YAML - ${e.message}`);
        }

        if (!Array.isArray(steps)) {
            throw new Error(`Invalid steps input - Must be an YAML array`);
        }

        const stepIds = new Set();
        for (const step of steps) {
            if (step.id !== undefined) {
                if (!String(step.id).match(/^[a-zA-Z_][a-zA-Z0-9_-]{1,100}$/)) {
                    throw new Error(`Invalid steps input - The identifier '${step.id}' is invalid.` +
                        `IDs may only contain alphanumeric characters, '_', and '-'. IDs must start with a letter or '_' and and must be less than 100 characters.`);
                }
                if (stepIds.has(step.id)) {
                    throw new Error(`Invalid steps input - The identifier '${step.id}' may not be used more than once within the same scope.`);
                }

                stepIds.add(step.id);
            }
        }

        return steps;
    }),
    defaults: getInput("defaults", {required: false}, (value) => {
        try {
            return YAML.parse(value);
        } catch (e) {
            throw new Error(`Invalid defaults input - Invalid YAML - ${e.message}`);
        }
    }),
}

export async function run(stage) {
    const steps = inputs.steps.map((step, index) => ({
        index,
        actJobId: `Step${index}`,
        // map prerequisite steps to step indices
        needs: step.needs?.map((prerequisiteStep, index) => {
            const prerequisiteStepIndex = isInt(prerequisiteStep) ? parseInt(prerequisiteStep)
                : inputs.steps.findIndex((step) => step.id === prerequisiteStep)
            if (prerequisiteStepIndex < 0 || prerequisiteStepIndex >= inputs.steps.length) {
                throw new Error(`Invalid value for steps.${index}.needs: ${prerequisiteStep}.`)
            }
            return prerequisiteStepIndex;
        }),

        config: {
            ...step,
            needs: undefined,
        },
        result: {
            status: 'Queued', // Queued, In Progress or Completed
            output: '',
            outputGroup: false,
            outcome: null,
            continueOnError: false,
            executionTime: null,
            commands: {
                /** @type {Record<string,string>} */
                output: {},
                /** @type {Record<string,string>} */
                env: {},
                /** @type {Array<string>} */
                path: [],
                /** @type {Array<string>} */
                summary: [],
                /** @type {Array<string>} */
                mask: [],
            },
            get conclusion() {
                if (this.continueOnError && this.outcome === 'failure') {
                    return 'success';
                }
                return this.outcome;
            },
        }
    }));

    let concurrentLogGroup = false

    function concurrentLog(...args) {
        if (!concurrentLogGroup) {
            console.log('');
            core.startGroup(colorize(" Concurrent logs", 'Gray', false));
            concurrentLogGroup = true;
        }
        console.log(...args);
    }

    if (stage === 'Pre') {
        await fs.writeFile(actLogFilePath, ''); // ensure the act log file exists
        await startAct(steps, inputs.defaults, inputs.githubToken, actLogFilePath);
    } else {
        const stageOrder = ['Pre', 'Main', 'Post'];
        const previousStage = stageOrder[stageOrder.indexOf(stage) - 1];
        // TODO refactor stage run indicator (also see below)
        const previousStageFilePath = path.join(ACTION_STEP_TEMP_DIR, `.Stage-${previousStage}-Start`);
        const skip = !await fs.access(previousStageFilePath).then(() => true).catch(() => false);
        if (skip) {
            core.debug(`Skipping ${stage} stage`);
            return;
        }
    }

    const stagePromise = new CompletablePromise();
    core.debug(colorize(`__::Act::${stage}::Start::`, 'Purple', true));

    await fs.appendFile(errorStepsFilePath, ''); // ensure the error steps file exists
    const errorStepsFileContent = await fs.readFile(errorStepsFilePath).then((buffer) => buffer.toString());
    const errorSteps = errorStepsFileContent.split('\n').filter((line) => !!line);
    for (const stepIndex of errorSteps) {
        await endStep(stepIndex, 'error');
    }

    // --- tail act log file
    const actLogTail = new TailFile(actLogFilePath, {startPos: stage === 'Pre' ? 0 : null});
    await actLogTail.start();
    readline.createInterface({input: actLogTail, crlfDelay: Infinity})
        .on('line', async (line) => {
            if (!line || stagePromise.status !== 'pending') {
                return;
            }

            TRACE && concurrentLog(colorize(line, 'Cyan', true));
            line = parseActLine(line);

            if (line.error) {
                const ignore = line.error === 'repository does not exist';
                if (!ignore) {
                    let error = new Error(`${line.error} - ${line.msg}`)
                    if (line.error === 'workflow is not valid') {
                        const workflowStepError = line.msg.match(/Failed to match run-step: Line: (?<line>\d+) Column (?<column>\d+): (?<msg>.*)$/)?.groups;
                        error = new Error(`Invalid steps input` + (workflowStepError
                            ? ` - Line: ${workflowStepError.line - 11} Column ${workflowStepError.column - 6}: ${workflowStepError?.msg ?? line.msg}`
                            : ` - ${line.msg}`));
                    }
                    stagePromise.reject(error);
                    return;
                }
            }

            if (!line.jobID) return;
            const stepIndex = parseInt(line.jobID.replace(/^\D*/, ''));
            const step = steps[stepIndex];
            if (!step) throw Error(`Unexpected step index: ${stepIndex}`);

            // actual step lines
            if (line.stepID?.[0] === 'main') {
                if (!line.raw_output) {
                    if (line.event === 'Start') {
                        await startStep(stepIndex);
                    } else if (line.event === 'ContinueOnError') {
                        step.result.continueOnError = true;
                    } else if (line.event === 'End') {
                        step.result.executionTime = line.executionTime;
                        step.result.outcome = line.stepResult;
                        // NOTE: endStep(...) is called at __::interceptor:: end event
                    } else if (line.command) {
                        // command files
                        // noinspection SpellCheckingInspection
                        switch (line.command) {
                            case 'group': {
                                const msg = `▼ ${line.arg}`;
                                concurrentLog(
                                    buildStepLogPrefix() +
                                    buildStepIndicator(stepIndex) +
                                    msg,
                                );
                                step.result.output += msg + EOL;
                                step.result.outputGroup = true
                                break;
                            }
                            case 'endgroup':
                                step.result.outputGroup = false
                                break;

                            case 'add-matcher':
                            case 'remove-matcher':
                                step.result.output += line.raw + EOL;
                                break;

                            case 'set-output':
                                step.result.commands.output[line.name] = line.arg;
                                break;
                            case 'set-env':
                                // skip GITHUB_ENV variables that are passed to and set by the interceptor action, see startAct()
                                if (!Object.keys(ACTION_ENV).includes(line.arg)) {
                                    step.result.commands.env[line.name] = line.arg;
                                }
                                break;
                            case 'add-path':
                                step.result.commands.path.push(line.arg);
                                break;
                            case 'summary':
                                step.result.commands.summary.push(line.content);
                                break;
                            case 'add-mask':
                                step.result.commands.mask.push(line.arg);
                                break;

                            case 'notice':
                            case 'warning':
                            case 'error':
                            case 'debug': {
                                let concurrentLogMsg = line.raw.replace(/^::[^:]+::/, '');
                                switch (line.command) {
                                    case 'notice':
                                        // keep default color
                                        break;
                                    case 'warning':
                                        concurrentLogMsg = colorize(concurrentLogMsg, 'Yellow', true);
                                        break;
                                    case 'error':
                                        concurrentLogMsg = colorize(concurrentLogMsg, 'Red', true);
                                        break;
                                    case 'debug':
                                        concurrentLogMsg = colorize(concurrentLogMsg, 'Gray');
                                        break;
                                }
                                concurrentLog(
                                    buildStepLogPrefix() +
                                    buildStepIndicator(stepIndex) +
                                    (step.result.outputGroup ? `  ${concurrentLogMsg}` : concurrentLogMsg),
                                );

                                step.result.output += (step.result.outputGroup
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
                                step.result.output += line.raw + EOL;
                        }
                    } else if (line.level === 'error') {
                        if (line.msg.startsWith('failed to fetch ')) {
                            const workflowStepError = line.msg.match(/GoGitActionCache (?<msg>failed to fetch \S+ with ref \S+)/)?.groups;
                            const errorMessage = workflowStepError?.msg ?? line.msg;
                            concurrentLog(
                                buildStepLogPrefix() +
                                buildStepIndicator(stepIndex) +
                                (step.result.outputGroup ? `  ${colorize(errorMessage, 'Red', true)}` : colorize(errorMessage, 'Red', true)),
                            );
                            step.result.output += '::error::' + (step.result.outputGroup ? `  ${errorMessage}` : errorMessage) + EOL;
                            await endStep(stepIndex, 'error');
                        }
                    }
                } else {
                    // raw output lines
                    let concurrentLogMsg = line.msg;
                    if (concurrentLogMsg.startsWith('[command]')) {
                        concurrentLogMsg = concurrentLogMsg.replace(/^\[command]/, '');
                        concurrentLogMsg = colorize(concurrentLogMsg, 'Blue');
                    }
                    concurrentLog(
                        buildStepLogPrefix() +
                        buildStepIndicator(stepIndex) +
                        (step.result.outputGroup ? `  ${concurrentLogMsg}` : concurrentLogMsg),
                    );

                    let outputMsg = line.msg;
                    if (outputMsg.startsWith('[command]')) {
                        outputMsg = outputMsg.replace(/^\[command]/, '')
                        outputMsg = colorize(outputMsg, 'Blue');
                    }
                    step.result.output += (step.result.outputGroup ? `  ${outputMsg}` : outputMsg) + EOL;
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
                if (step.result.status !== 'Completed') {
                    const result = stage !== 'Post' ? 'error' : null;
                    await endStep(stepIndex, result);
                }
            }
        });

    // TODO refactor stage run indicator
    await fs.writeFile(path.join(ACTION_STEP_TEMP_DIR, `.Stage-${stage}-Start`), '');

    let initialSteps = steps;
    if (stage === 'Main') {
        // only trigger those steps that do not have prerequisites
        initialSteps = initialSteps.filter((step => step.needs === undefined || step.needs.length === 0))
    }
    initialSteps.forEach((step) => actInterceptor.triggerStage(ACTION_STEP_TEMP_DIR, stage, step.actJobId));

    await stagePromise
        .finally(() => actLogTail.quit());

    if (stage === 'Post') {
        const actPid = parseInt(core.getState('act-pid'));
        try {
            process.kill(actPid)
        } catch (error) {
            core.debug(`Failed to kill act process with PID ${actPid}: ${error.message}`);
        }
    }

    async function startStep(stepIndex) {
        const step = steps[stepIndex];

        step.result.status = 'In Progress';

        core.debug(buildStepLogPrefix() +
            buildStepIndicator(step.index) +
            colorize(`__::Step::${stage}::Start::`, 'Blue', true)
        );
        concurrentLog(
            buildStepLogPrefix('Start') +
            buildStepIndicator(step.index) +
            buildStepHeadline(stage, step.config),
        );
    }

    async function endStep(stepIndex, outcome) {
        const step = steps[stepIndex];

        if (outcome) {
            step.result.outcome = outcome === 'error' ? 'failure' : outcome;
        }
        if (step.result.outcome === null) {
            step.result.outcome = 'skipped';
        }
        if (step.result.outcome === 'error') {
            await fs.appendFile(errorStepsFilePath, stepIndex + EOL);
        }

        if (step.result.status === 'In Progress') {
            step.result.status = 'Completed';
            concurrentLog(
                buildStepLogPrefix('End', step.result.conclusion) +
                buildStepIndicator(stepIndex) +
                buildStepHeadline(stage, step.config, step.result.executionTime),
            );
            core.debug(buildStepLogPrefix() +
                buildStepIndicator(stepIndex) +
                colorize(`__::Step::${stage}::End::`, 'Blue', true),
            );
        } else if (step.result.status === 'Queued') {
            step.result.status = 'Completed';
            // do nothing, the step was never started
        } else {
            throw new Error(`Unexpected step result. Step was not running: ${step.index}, was ${step.result.status}`);
        }

        // check if the stage has been completed
        if (steps.every((step) => step.result.status === 'Completed')) {
            if (concurrentLogGroup) {
                core.endGroup();
                console.log('');
            }

            steps
                .filter((step) => stage === "Main" || step.result.conclusion !== 'skipped')
                .forEach((step, completedStepsIndex, completedSteps) => {
                    // log aggregated step results
                    core.startGroup(' ' +
                        buildStepLogPrefix('End', step.result.conclusion) +
                        buildStepHeadline(stage, step.config, step.result.executionTime),
                    );
                    console.log(removeTrailingNewLine(step.result.output));
                    core.endGroup();

                    // add a new line between steps
                    if (completedStepsIndex < completedSteps.length - 1) {
                        console.log('');
                    }

                    // command files
                    Object.entries(step.result.commands.output).forEach(([key, value]) => {
                        core.debug(colorize(`Set output: ${key}=${value}`, 'Purple'));
                        core.setOutput(key, value);
                        if (step.id) {
                            const stepKey = step.id + '--' + key;
                            core.debug(colorize(`Set output: ${stepKey}=${value}`, 'Purple'));
                            core.setOutput(stepKey, value);
                        }
                    });
                    Object.entries(step.result.commands.env).forEach(([key, value]) => {
                        core.debug(colorize(`Set env: ${key}=${value}`, 'Purple'));
                        core.exportVariable(key, value);
                    });
                    step.result.commands.path.forEach((path) => {
                        core.debug(colorize(`Add path: ${path}`, 'Purple'));
                        core.addPath(path);
                    });
                    step.result.commands.summary.forEach((summary) => {
                        core.debug(colorize(`Step summary: ${summary}`, 'Purple'));
                        core.summary.addRaw(summary, true).write();
                    });

                    step.result.commands.mask.forEach((mask) => {
                        core.debug(colorize(`Add mask: ***`, 'Purple'));
                        core.setSecret(mask);
                    });
                });

            if (stage === 'Main') {
                steps
                    .filter((step) => step.config.id)
                    .forEach((step) => {
                        const outcomeKey = step.config.id + '--outcome';
                        core.debug(colorize(`Set output: ${outcomeKey}=${step.result.outcome}`, 'Purple'));
                        core.setOutput(outcomeKey, step.result.outcome);

                        const conclusionKey = step.config.id + '--conclusion';
                        core.debug(colorize(`Set output: ${conclusionKey}=${step.result.conclusion}`, 'Purple'));
                        core.setOutput(conclusionKey, step.result.conclusion);
                    })
            }

            core.debug(colorize(`__::Act::${stage}::End::`, 'Purple', true));

            // complete stage promise
            if (steps.every((step) => step.result.conclusion === 'success'
                || step.result.conclusion === 'skipped'
                || !step.result.conclusion)) {
                stagePromise.resolve();
            } else {
                stagePromise.reject("step failure");
            }
        } else if (stage === 'Main') {
            const completedStep = step;
            steps
                .filter((step) => step.result.status === 'Queued'
                    && step.needs?.includes(completedStep.index)
                    // check if all prerequisite steps have been completed
                    && step.needs.every((stepIndex) => steps[stepIndex].result.status === 'Completed')
                )
                .forEach((step) => {
                    const skip = step.needs.some((stepIndex) => steps[stepIndex].result.conclusion !== 'success');
                    actInterceptor.triggerStage(ACTION_STEP_TEMP_DIR, stage, step.actJobId, skip ? 'skip' : 'continue');
                })

        }
    }
}

async function startAct(steps, defaults, githubToken, logFilePath) {
    const actInterceptorConfig = {
        host: {
            tempDir: ACTION_STEP_TEMP_DIR,
            workingDirectory: process.cwd(),
            env: ACTION_ENV,
        }

    };
    const actInterceptorConfigPath = path.join(ACTION_STEP_TEMP_DIR, 'steps-config.json');
    await fs.writeFile(actInterceptorConfigPath, JSON.stringify(actInterceptorConfig));


    const workflow = {
        on: process.env["GITHUB_EVENT_NAME"],
        defaults: defaults ?? undefined,
        jobs: Object.fromEntries(steps.map((step) => [step.actJobId, {
            "runs-on": "host", // refers to gh act command parameter "--platform host=-self-hosted",
            "steps": [
                {
                    id: 'pre',
                    uses: "__/act-interceptor@local",
                    with: {
                        'config': actInterceptorConfigPath,
                        'step': 'Pre',
                        'act-job-id': step.actJobId,
                    },
                },
                {
                    ...step.config,
                    id: 'main',
                },
                {
                    if: "always()",
                    uses: "__/act-interceptor@local",
                    with: {
                        'config': actInterceptorConfigPath,
                        'step': 'Post',
                        'act-job-id': step.actJobId,
                    },
                },
            ],
            "env": {
                // WORKAROUND
                // GITHUB_ACTION cant be overwritten by act --env nor by core.exportVariable of the interceptor pre-step,
                // therefore we need to set it as an environment variable of the step itself.
                "GITHUB_ACTION": process.env["GITHUB_ACTION"] + `_${step.index}`,
                "X_GITHUB_ACTION": process.env["GITHUB_ACTION"] + `_${step.index}`,
            },
        }])),
    }

    const workflowFilePath = path.join(ACTION_STEP_TEMP_DIR, 'steps-workflow.yaml');
    const workflowYaml = YAML.stringify(workflow);
    TRACE && console.log('act step workflow:\n', colorize(workflowYaml, 'green'))
    await fs.writeFile(workflowFilePath, workflowYaml);

    const actLogFile = await fs.open(logFilePath, 'w');
    // noinspection JSCheckFunctionSignatures, SpellCheckingInspection

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

            // TODO check if needed
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

function isInt(value) {
    if (typeof value === 'string' && value.trim()) {
        value = Number(value);
    }

    return Number.isInteger(value);
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
        } else if (result.msg === 'Failed but continue next step') {
            // continue-on-error: true
            result.event = 'ContinueOnError';
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

function buildStepHeadline(actStage, step, executionTime) {
    let groupHeadline = '';

    if (actStage !== 'Main') {
        groupHeadline += `${actStage} `;
    }

    groupHeadline += `Run ${buildStepDisplayName(step)}`;

    if (executionTime) {
        groupHeadline += colorize(` [${formatMilliseconds(executionTime / 1_000_000)}]`, 'Gray', true);
    }

    return groupHeadline;
}

function buildStepLogPrefix(event, stepResult) {
    if (event === 'Start') {
        return colorize('○ ', 'Gray', true);
    }

    if (event === 'End') {
        if (stepResult === 'skipped') {
            return colorize('◯ ', 'Gray', true);
        }

        // no job result indicates the step action has no stage implementation
        if (!stepResult || stepResult === 'success') {
            return colorize('⬤ ', 'Gray', true);
        }

        return colorize('⬤ ', 'Red', true);
    }

    return colorize('  ', 'Gray', true);
}

function buildStepIndicator(stepIndex) {
    return colorize(`[${stepIndex}] `, 'Gray', true);
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
    // noinspection SpellCheckingInspection
    core.debug(`Installing gh cli extension nektos/gh-act@${actVersionTag} ...`);
    child_process.execSync(`gh extension install https://github.com/nektos/gh-act --pin ${actVersionTag}`, {
        stdio: 'inherit',
        env: {...process.env, GH_TOKEN: githubToken}
    });

    const installedActVersion = child_process.execSync("gh act --version").toString().trim()
        .split(/\s/).at(-1);
    if (installedActVersion !== GH_ACT_VERSION) {
        core.warning(`Installed gh act version (${installedActVersion}) does not match expected version (${GH_ACT_VERSION}).`);
    }
}
