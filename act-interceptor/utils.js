import fs from "node:fs";
import path from "node:path";

export const TRACE = process.env["RUNNER_DEBUG"] === "2";
export const DEBUG = process.env["RUNNER_DEBUG"] === "1" || TRACE;
export const LOCAL = process.env["RUNNER_LOCAL"] === "1";

// WORKAROUND: see startAct() in steps-runner.js
process.env["GITHUB_ACTION"] = process.env["X_GITHUB_ACTION"] ?? process.env["GITHUB_ACTION"];

export const ACTION_STEP_TEMP_DIR = `${process.env["RUNNER_TEMP"]}/${process.env["GITHUB_ACTION"]}`;
{
    if (!process.env["RUNNER_TEMP"] || !process.env["GITHUB_ACTION"]) {
        throw new Error("RUNNER_TEMP and GITHUB_ACTION environment variables are required "
            + "to create a temporary directory for an action.");
    }
    await fs.promises.mkdir(ACTION_STEP_TEMP_DIR, {recursive: true});
}

export async function untilFilePresent(filePath) {
    const dirname = path.dirname(filePath);
    const basename = path.basename(filePath);
    if (!basename) throw new Error("Invalid file path: " + filePath);

    const watcher = fs.promises.watch(dirname);
    try {
        await fs.promises.access(filePath);
    } catch (e) {
        for await (const {eventType, filename} of watcher) {
            if (filename === basename && eventType === 'rename') {
                break;
            }
        }
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extendBasename(filePath, annex) {
    const pathSplit = filePath.split('/');
    pathSplit.push(pathSplit.pop().replace(/^([^.]+)/, '$1' + annex));
    return pathSplit.join('/');
}

export function colorizeCyan(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;36m${line}\x1b[0m`)
        .join('\n');
}

export function colorizeGray(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;90m${line}\x1b[0m`)
        .join('\n');
}

export function colorizeRed(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;31m${line}\x1b[0m`)
        .join('\n');
}

export function colorizeYellow(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;33m${line}\x1b[0m`)
        .join('\n');
}

export function colorizePurple(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;35m${line}\x1b[0m`)
        .join('\n');
}

export function colorizeBlue(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;34m${line}\x1b[0m`)
        .join('\n');
}

export class CompletablePromise extends Promise {
    status = 'pending';

    constructor(callback = () => {
    }) {
        let _resolve = null;
        let _reject = null;
        super((resolve, reject) => {
            _resolve = resolve;
            _reject = reject;
            return callback(resolve, reject);
        });

        this.resolve = (value) => {
            this.status = 'resolved';
            _resolve(value)
        };
        this.reject = (reason) => {
            this.status = 'rejected';
            _reject(reason);
        }
    }
}

export function isRunning(pid) {
    try {
        return process.kill(pid, 0)
    } catch (e) {
        return e.code === 'EPERM'
    }
}
