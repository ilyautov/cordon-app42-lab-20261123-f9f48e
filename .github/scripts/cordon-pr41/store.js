import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const runIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export function validatePrSelection(repo, number) {
    if (typeof repo !== 'string' || !repoPattern.test(repo) || !Number.isSafeInteger(number) || number < 1 ||
        repo.split('/').some((part) => part === '.' || part === '..'))
        throw new Error('invalid PR target');
}
function validBaseRef(ref) {
    return typeof ref === 'string' && ref.length > 0 && ref.length <= 255 &&
        !ref.startsWith('-') && ref !== '@' && !ref.endsWith('.') && !ref.includes('..') && !ref.includes('@{') &&
        !Array.from(ref).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 ||
            '~^:?*[\\'.includes(char)) &&
        ref.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}
function validId(id) {
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}
function validMergeProfile(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const profile = value;
    return Object.keys(profile).length === 5 && validBaseRef(profile.baseRef) &&
        validId(profile.mergeAppId) && validId(profile.statusAppId) &&
        typeof profile.statusAppSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/u.test(profile.statusAppSlug) &&
        typeof profile.statusContext === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/u.test(profile.statusContext);
}
export function parseMergeProfile(value) {
    if (!validMergeProfile(value))
        throw new Error('invalid merge profile');
    const { baseRef, statusAppId, statusAppSlug, statusContext, mergeAppId } = value;
    return { baseRef, statusAppId, statusAppSlug, statusContext, mergeAppId };
}
export function validMergePolicy(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const evidence = value;
    return Object.keys(evidence).length === 3 && validMergeProfile(evidence.profile) &&
        validId(evidence.repositoryId) &&
        typeof evidence.rulesSha256 === 'string' && digestPattern.test(evidence.rulesSha256);
}
export function sameMergePolicy(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    return left.repositoryId === right.repositoryId && left.rulesSha256 === right.rulesSha256 &&
        left.profile.baseRef === right.profile.baseRef &&
        left.profile.statusAppId === right.profile.statusAppId &&
        left.profile.statusAppSlug === right.profile.statusAppSlug &&
        left.profile.statusContext === right.profile.statusContext &&
        left.profile.mergeAppId === right.profile.mergeAppId;
}
export function validateTarget(target) {
    validatePrSelection(target.repo, target.number);
    if (typeof target.headSha !== 'string' || !shaPattern.test(target.headSha) ||
        typeof target.baseSha !== 'string' || !shaPattern.test(target.baseSha) ||
        !validBaseRef(target.baseRef))
        throw new Error('invalid PR snapshot');
}
export function sameSnapshot(left, right) {
    return left.repo.toLowerCase() === right.repo.toLowerCase() && left.number === right.number &&
        left.headSha === right.headSha && left.baseRef === right.baseRef && left.baseSha === right.baseSha;
}
function validEvent(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const event = value;
    try {
        validateTarget(event);
    }
    catch {
        return false;
    }
    return (event.kind === 'diff-read' || event.kind === 'merge-proposed') &&
        typeof event.diffSha256 === 'string' && digestPattern.test(event.diffSha256) &&
        Object.keys(event).length === 7;
}
export function appendReviewEvent(path, event) {
    if (!validEvent(event))
        throw new Error('invalid review event');
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
        constants.O_NOFOLLOW, 0o600);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0)
            throw new Error('review ledger must be a private regular file');
        writeFileSync(fd, JSON.stringify(event) + '\n');
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function readPrivate(path) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0)
            throw new Error('expected a private regular file');
        return readFileSync(fd, 'utf8');
    }
    finally {
        closeSync(fd);
    }
}
export function readReviewEvents(path) {
    try {
        return readPrivate(path).split('\n').filter(Boolean).map((line) => {
            const event = JSON.parse(line);
            if (!validEvent(event))
                throw new Error('invalid review event');
            return event;
        });
    }
    catch {
        throw new Error('invalid staged review evidence');
    }
}
function validReceipt(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const receipt = value;
    try {
        validateTarget(receipt);
    }
    catch {
        return false;
    }
    const hasMergePolicy = Object.hasOwn(receipt, 'mergePolicy');
    return receipt.kind === 'review-completed' && Object.keys(receipt).length === (hasMergePolicy ? 10 : 9) &&
        (!hasMergePolicy || (validMergePolicy(receipt.mergePolicy) && receipt.mergePolicy.profile.baseRef === receipt.baseRef)) &&
        typeof receipt.runId === 'string' && runIdPattern.test(receipt.runId) &&
        typeof receipt.diffSha256 === 'string' && digestPattern.test(receipt.diffSha256) &&
        typeof receipt.mergeProposed === 'boolean';
}
export function readReviewReceipt(path) {
    try {
        const receipt = JSON.parse(readPrivate(path));
        if (validReceipt(receipt))
            return receipt;
    }
    catch {
        // Missing, partial or unreadable evidence never counts as a completed review.
    }
    throw new Error('invalid completed review receipt');
}
export function requireNewReceiptPath(path) {
    try {
        lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    throw new Error('review receipt already exists');
}
export function publishReviewReceipt(path, receipt) {
    if (!validReceipt(receipt))
        throw new Error('invalid completed review receipt');
    const staged = join(dirname(path), `.review-${randomUUID()}.part`);
    const fd = openSync(staged, 'wx', 0o600);
    try {
        try {
            writeFileSync(fd, JSON.stringify(receipt) + '\n');
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        // A completed private file becomes visible without replacing another run's receipt.
        linkSync(staged, path);
    }
    finally {
        rmSync(staged, { force: true });
    }
}
//# sourceMappingURL=store.js.map