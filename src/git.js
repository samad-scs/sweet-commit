import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as p from '@clack/prompts';
import { DIFF_CONFIG } from './config.js';

const execPromise = promisify(exec);

export async function execGit(command, options = {}) {
  try {
    const { stdout } = await execPromise(command, {
      maxBuffer: DIFF_CONFIG.maxBuffer,
      ...options,
    });
    return stdout;
  } catch (error) {
    if (error.message.includes('maxBuffer length exceeded')) {
      throw new Error(
        `The changeset is extremely large (>50MB). Consider committing files in smaller batches.`,
      );
    }
    throw error;
  }
}

export async function checkStagedChanges() {
  try {
    const stdout = await execGit('git status --porcelain');
    const hasStagedChanges = stdout
      .split('\n')
      .some(
        (line) =>
          line.startsWith('A ') ||
          line.startsWith('M ') ||
          line.startsWith('D ') ||
          line.startsWith('R '),
      );

    if (!hasStagedChanges) {
      p.cancel('No staged changes found. Stage your changes first with: git add .');
      process.exit(1);
    }
  } catch (error) {
    p.cancel(`Unable to check git status: ${error.message}`);
    process.exit(1);
  }
}

export async function getFileStats() {
  try {
    const stdout = await execGit('git diff --cached --name-status');
    const files = stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [status, ...pathParts] = line.split('\t');
        return { status, path: pathParts.join('\t') };
      });
    return files;
  } catch (error) {
    p.cancel(`Unable to analyze changed files: ${error.message}`);
    process.exit(1);
  }
}

export async function getStagedDiff() {
  try {
    const stdout = await execGit('git diff --cached');
    return stdout;
  } catch (error) {
    if (error.message.includes('extremely large')) {
      p.note(error.message, 'Large Changeset Warning');

      try {
        const stats = await execGit('git diff --cached --stat');
        const numstat = await execGit('git diff --cached --numstat');

        return `LARGE_CHANGESET_SUMMARY\n\nStatistics:\n${stats}\n\nDetailed changes:\n${numstat}`;
      } catch {
        p.cancel(
          "Unable to process this changeset - it's too large even for statistical analysis. Try committing files in smaller batches.",
        );
        process.exit(1);
      }
    } else {
      p.cancel(`Unable to get staged changes: ${error.message}`);
      process.exit(1);
    }
  }
}

export async function commitChanges(message) {
  if (!message || message.trim().length === 0) {
    p.cancel('Cannot commit with empty message.');
    process.exit(1);
  }

  const spinner = p.spinner();
  spinner.start('Committing changes...');

  let tempFile;
  try {
    tempFile = path.join(os.tmpdir(), `scom-${Date.now()}.txt`);
    await fs.writeFile(tempFile, message, 'utf8');

    await execGit(`git commit -F "${tempFile}"`);
    await fs.unlink(tempFile);

    spinner.stop('Committed successfully!');
  } catch (error) {
    spinner.stop('Commit failed!');

    if (tempFile) {
      try {
        await fs.unlink(tempFile);
      } catch {
        // ignore cleanup error
      }
    }

    p.cancel(`Unable to create commit: ${error.message}`);
    process.exit(1);
  }
}

async function getRepoInfo() {
  const repoUrl = (await execGit('git config --get remote.origin.url')).trim();

  // Supports:
  // git@github.com:owner/repo.git
  // https://github.com/owner/repo.git
  const regex = /[:/]([^/]+)\/(.+)\.git$/;
  const match = repoUrl.match(regex);

  if (!match) {
    throw new Error('Unable to parse GitHub remote URL');
  }

  const owner = match[1]?.replace('github.com/', '/');
  const repo = match[2];

  return { owner, repo };
}

async function createPRToDev(owner, repo, branch) {
  try {
    const output = await execPromise(
      `gh pr create \
        --repo ${owner}/${repo} \
        --base dev \
        --head ${branch} \
        --title "Sync ${branch} → dev" \
        --body "Automated merge by sweet-commit"`,
    );

    // gh prints PR URL like:
    // https://github.com/owner/repo/pull/123
    const match = output.stdout.trim().match(/pull\/(\d+)/);
    const prNumber = match ? match[1] : null;

    if (!prNumber) throw new Error('Unable to detect PR number');

    return prNumber;
  } catch (err) {
    p.cancel(`Failed to create PR: ${err.message}`);
    process.exit(1);
  }
}

export async function mergeIntoDev() {
  const branch = (await execGit('git rev-parse --abbrev-ref HEAD')).trim();
  p.note(`Merging ${branch} → dev`, 'Auto-merge');
  const { owner, repo } = await getRepoInfo();
  p.note(`owner ${owner} repo ${repo}`, 'Auto-merge');

  const prNumber = await createPRToDev(owner, repo, branch);

  try {
    await execPromise(
      `gh pr merge ${prNumber} \
        --repo ${owner}/${repo} \
        --merge`,
    );

    p.note('Merged to dev successfully', 'Merge');
  } catch (err) {
    p.cancel(`Failed to merge into dev: ${err.message}`);
    process.exit(1);
  }
}

export async function createDevToStagingPR() {
  p.note('Creating PR from dev → staging', 'PR');

  const { owner, repo } = await getRepoInfo();
  p.note(`owner ${owner} repo ${repo}`, 'Auto-merge');

  try {
    const output = await execPromise(
      `gh pr create \
        --title "Sync dev → staging" \
        --body "Automated merge by sweet-commit" \
        --base staging \
        --head dev \
        --label 🤖JARVIS \
        --repo ${owner}/${repo}`,
    );

    const text = output.stdout.trim();

    // Extract URL
    const urlMatch = text.match(/https:\/\/github\.com\/[^\s]+/);
    const prUrl = urlMatch ? urlMatch[0] : null;

    if (!prUrl) {
      p.note(text, 'Raw gh output');
      throw new Error('Could not detect PR URL from gh output');
    }

    p.note(`Pull Request Created:\n${prUrl}`, 'PR URL');
    return prUrl;
  } catch (err) {
    p.cancel(`Failed to create PR: ${err.message}`);
    process.exit(1);
  }
}
