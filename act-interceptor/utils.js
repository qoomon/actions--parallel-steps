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

export function colorize(text, foregroundColor, bold = false) {
    const foregroundColorCode = {
        'black': 30,
        'red': 31,
        'green': 32,
        'yellow': 33,
        'blue': 34,
        'purple': 35,
        'cyan': 36,
        'white': 37,
        'gray': 90
    }[foregroundColor.toLowerCase()];
    if(!foregroundColorCode) {
        throw new Error(`Unsupported foreground color: ${foregroundColor}`);
    }
    const prefix = `\x1b[${bold ? 1 : 0};${foregroundColorCode}m`;
    const suffix = '\x1b[0m';
    return text.split("\n")
        .map((line) => `${prefix}${line}${suffix}`)
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
