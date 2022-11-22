"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCategoryInput = exports.getAnalyzeSteps = exports.getWorkflowRunID = exports.getWorkflowPath = exports.getWorkflow = exports.formatWorkflowCause = exports.formatWorkflowErrors = exports.validateWorkflow = exports.getWorkflowErrors = exports.WorkflowErrors = exports.patternIsSuperset = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const core = __importStar(require("@actions/core"));
const yaml = __importStar(require("js-yaml"));
const api = __importStar(require("./api-client"));
const util_1 = require("./util");
function isObject(o) {
    return o !== null && typeof o === "object";
}
const GLOB_PATTERN = new RegExp("(\\*\\*?)");
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}
function patternToRegExp(value) {
    return new RegExp(`^${value
        .toString()
        .split(GLOB_PATTERN)
        .reduce(function (arr, cur) {
        if (cur === "**") {
            arr.push(".*?");
        }
        else if (cur === "*") {
            arr.push("[^/]*?");
        }
        else if (cur) {
            arr.push(escapeRegExp(cur));
        }
        return arr;
    }, [])
        .join("")}$`);
}
// this function should return true if patternA is a superset of patternB
// e.g: * is a superset of main-* but main-* is not a superset of *.
function patternIsSuperset(patternA, patternB) {
    return patternToRegExp(patternA).test(patternB);
}
exports.patternIsSuperset = patternIsSuperset;
function branchesToArray(branches) {
    if (typeof branches === "string") {
        return [branches];
    }
    if (Array.isArray(branches)) {
        if (branches.length === 0) {
            return "**";
        }
        return branches;
    }
    return "**";
}
function toCodedErrors(errors) {
    return Object.entries(errors).reduce((acc, [code, message]) => {
        acc[code] = { message, code };
        return acc;
    }, {});
}
// code to send back via status report
// message to add as a warning annotation to the run
exports.WorkflowErrors = toCodedErrors({
    MismatchedBranches: `Please make sure that every branch in on.pull_request is also in on.push so that Code Scanning can compare pull requests against the state of the base branch.`,
    MissingPushHook: `Please specify an on.push hook so that Code Scanning can compare pull requests against the state of the base branch.`,
    PathsSpecified: `Using on.push.paths can prevent Code Scanning annotating new alerts in your pull requests.`,
    PathsIgnoreSpecified: `Using on.push.paths-ignore can prevent Code Scanning annotating new alerts in your pull requests.`,
    CheckoutWrongHead: `git checkout HEAD^2 is no longer necessary. Please remove this step as Code Scanning recommends analyzing the merge commit for best results.`,
});
function getWorkflowErrors(doc) {
    var _a, _b, _c, _d, _e;
    const errors = [];
    const jobName = process.env.GITHUB_JOB;
    if (jobName) {
        const job = (_a = doc === null || doc === void 0 ? void 0 : doc.jobs) === null || _a === void 0 ? void 0 : _a[jobName];
        const steps = job === null || job === void 0 ? void 0 : job.steps;
        if (Array.isArray(steps)) {
            for (const step of steps) {
                // this was advice that we used to give in the README
                // we actually want to run the analysis on the merge commit
                // to produce results that are more inline with expectations
                // (i.e: this is what will happen if you merge this PR)
                // and avoid some race conditions
                if ((step === null || step === void 0 ? void 0 : step.run) === "git checkout HEAD^2") {
                    errors.push(exports.WorkflowErrors.CheckoutWrongHead);
                    break;
                }
            }
        }
    }
    let missingPush = false;
    if (doc.on === undefined) {
        // this is not a valid config
    }
    else if (typeof doc.on === "string") {
        if (doc.on === "pull_request") {
            missingPush = true;
        }
    }
    else if (Array.isArray(doc.on)) {
        const hasPush = doc.on.includes("push");
        const hasPullRequest = doc.on.includes("pull_request");
        if (hasPullRequest && !hasPush) {
            missingPush = true;
        }
    }
    else if (isObject(doc.on)) {
        const hasPush = Object.prototype.hasOwnProperty.call(doc.on, "push");
        const hasPullRequest = Object.prototype.hasOwnProperty.call(doc.on, "pull_request");
        if (!hasPush && hasPullRequest) {
            missingPush = true;
        }
        if (hasPush && hasPullRequest) {
            const paths = (_b = doc.on.push) === null || _b === void 0 ? void 0 : _b.paths;
            // if you specify paths or paths-ignore you can end up with commits that have no baseline
            // if they didn't change any files
            // currently we cannot go back through the history and find the most recent baseline
            if (Array.isArray(paths) && paths.length > 0) {
                errors.push(exports.WorkflowErrors.PathsSpecified);
            }
            const pathsIgnore = (_c = doc.on.push) === null || _c === void 0 ? void 0 : _c["paths-ignore"];
            if (Array.isArray(pathsIgnore) && pathsIgnore.length > 0) {
                errors.push(exports.WorkflowErrors.PathsIgnoreSpecified);
            }
        }
        // if doc.on.pull_request is null that means 'all branches'
        // if doc.on.pull_request is undefined that means 'off'
        // we only want to check for mismatched branches if pull_request is on.
        if (doc.on.pull_request !== undefined) {
            const push = branchesToArray((_d = doc.on.push) === null || _d === void 0 ? void 0 : _d.branches);
            if (push !== "**") {
                const pull_request = branchesToArray((_e = doc.on.pull_request) === null || _e === void 0 ? void 0 : _e.branches);
                if (pull_request !== "**") {
                    const difference = pull_request.filter((value) => !push.some((o) => patternIsSuperset(o, value)));
                    if (difference.length > 0) {
                        // there are branches in pull_request that may not have a baseline
                        // because we are not building them on push
                        errors.push(exports.WorkflowErrors.MismatchedBranches);
                    }
                }
                else if (push.length > 0) {
                    // push is set up to run on a subset of branches
                    // and you could open a PR against a branch with no baseline
                    errors.push(exports.WorkflowErrors.MismatchedBranches);
                }
            }
        }
    }
    if (missingPush) {
        errors.push(exports.WorkflowErrors.MissingPushHook);
    }
    return errors;
}
exports.getWorkflowErrors = getWorkflowErrors;
async function validateWorkflow() {
    let workflow;
    try {
        workflow = await getWorkflow();
    }
    catch (e) {
        return `error: getWorkflow() failed: ${String(e)}`;
    }
    let workflowErrors;
    try {
        workflowErrors = getWorkflowErrors(workflow);
    }
    catch (e) {
        return `error: getWorkflowErrors() failed: ${String(e)}`;
    }
    if (workflowErrors.length > 0) {
        let message;
        try {
            message = formatWorkflowErrors(workflowErrors);
        }
        catch (e) {
            return `error: formatWorkflowErrors() failed: ${String(e)}`;
        }
        core.warning(message);
    }
    return formatWorkflowCause(workflowErrors);
}
exports.validateWorkflow = validateWorkflow;
function formatWorkflowErrors(errors) {
    const issuesWere = errors.length === 1 ? "issue was" : "issues were";
    const errorsList = errors.map((e) => e.message).join(" ");
    return `${errors.length} ${issuesWere} detected with this workflow: ${errorsList}`;
}
exports.formatWorkflowErrors = formatWorkflowErrors;
function formatWorkflowCause(errors) {
    if (errors.length === 0) {
        return undefined;
    }
    return errors.map((e) => e.code).join(",");
}
exports.formatWorkflowCause = formatWorkflowCause;
async function getWorkflow() {
    const relativePath = await getWorkflowPath();
    const absolutePath = path.join((0, util_1.getRequiredEnvParam)("GITHUB_WORKSPACE"), relativePath);
    return yaml.load(fs.readFileSync(absolutePath, "utf-8"));
}
exports.getWorkflow = getWorkflow;
/**
 * Get the path of the currently executing workflow.
 */
async function getWorkflowPath() {
    const repo_nwo = (0, util_1.getRequiredEnvParam)("GITHUB_REPOSITORY").split("/");
    const owner = repo_nwo[0];
    const repo = repo_nwo[1];
    const run_id = Number((0, util_1.getRequiredEnvParam)("GITHUB_RUN_ID"));
    const apiClient = api.getApiClient();
    const runsResponse = await apiClient.request("GET /repos/:owner/:repo/actions/runs/:run_id?exclude_pull_requests=true", {
        owner,
        repo,
        run_id,
    });
    const workflowUrl = runsResponse.data.workflow_url;
    const workflowResponse = await apiClient.request(`GET ${workflowUrl}`);
    return workflowResponse.data.path;
}
exports.getWorkflowPath = getWorkflowPath;
/**
 * Get the workflow run ID.
 */
function getWorkflowRunID() {
    const workflowRunID = parseInt((0, util_1.getRequiredEnvParam)("GITHUB_RUN_ID"), 10);
    if (Number.isNaN(workflowRunID)) {
        throw new Error("GITHUB_RUN_ID must define a non NaN workflow run ID");
    }
    return workflowRunID;
}
exports.getWorkflowRunID = getWorkflowRunID;
function getAnalyzeSteps(job) {
    const steps = job.steps;
    if (!Array.isArray(steps)) {
        throw new Error("Could not get analyze steps since job.steps was not an array.");
    }
    return steps.filter((step) => { var _a; return (_a = step.uses) === null || _a === void 0 ? void 0 : _a.includes("github/codeql-action/analyze"); });
}
exports.getAnalyzeSteps = getAnalyzeSteps;
function getCategoryInput(workflow) {
    if (!workflow.jobs) {
        throw new Error("Could not get category input since workflow.jobs was undefined.");
    }
    const categories = Object.values(workflow.jobs)
        .map((job) => getAnalyzeSteps(job).map((step) => { var _a; return (_a = step.with) === null || _a === void 0 ? void 0 : _a.category; }))
        .flat()
        .filter((category) => category !== undefined)
        .map((category) => category);
    if (categories.length === 0) {
        return undefined;
    }
    if (!categories.every((category) => category === categories[0])) {
        throw new Error("Could not get category input since multiple categories were specified by the analysis step.");
    }
    if (categories[0].includes("${{")) {
        throw new Error("Could not get category input since it contained a dynamic value.");
    }
    return categories[0];
}
exports.getCategoryInput = getCategoryInput;
//# sourceMappingURL=workflow.js.map