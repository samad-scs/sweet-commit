import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as p from '@clack/prompts';
import { DIFF_CONFIG } from './config.js';
import { generatePRDescription } from './utils.js';

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

export async function getCommitsBetween(base, head) {
  try {
    const stdout = await execGit(`git log ${base}..${head} --pretty=format:"- %s"`);
    return stdout.trim();
  } catch {
    return null;
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

    return hasStagedChanges;
  } catch (error) {
    p.cancel(`Unable to check git status: ${error.message}`);
    process.exit(1);
  }
}

export async function syncLocalWithDev() {
  p.note('Syncing with remote dev branch...', 'Safety Check');
  try {
    await execGit('git fetch origin dev');
    await execGit('git merge origin/dev');
    p.note('Local branch is up to date with dev.', 'Sync');
  } catch (error) {
    if (error.message.includes('CONFLICT') || error.stdout?.includes('CONFLICT')) {
      p.cancel(
        '🛑 Merge Conflicts Detected!\n' +
          'Automatic merge with dev failed. Please resolve conflicts manually, commit them, and run the command again.',
      );
      process.exit(1);
    } else {
      p.cancel(`Failed to sync with dev: ${error.message}`);
      process.exit(1);
    }
  }
}

export async function pushCurrentBranch() {
  p.note('Pushing to remote...', 'Auto-push');
  try {
    await execGit('git push');
  } catch (pushErr) {
    try {
      const branch = (await execGit('git rev-parse --abbrev-ref HEAD')).trim();
      await execGit(`git push --set-upstream origin ${branch}`);
    } catch {
      p.cancel(`Push failed: ${pushErr.message}`);
      process.exit(1);
    }
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
  const regex = /[:/]([^/]+)\/(.+)\.git$/;
  const match = repoUrl.match(regex);

  if (!match) {
    throw new Error('Unable to parse GitHub remote URL');
  }

  const owner = match[1]?.replace('github.com/', '/');
  const repo = match[2];

  return { owner, repo };
}

// UPDATED FUNCTION: Handles "No commits" error gracefully
async function createPRToDev(owner, repo, branch) {
  try {
    const commits = await getCommitsBetween('origin/dev', branch);
    const apiKey = process.env.GEMINI_API_KEY;
    let title = `Sync ${branch} → dev`;
    let body = 'Automated merge by sweet-commit';

    if (commits && apiKey) {
      const prInfo = await generatePRDescription(apiKey, commits);
      title = prInfo.title;
      body = prInfo.body;
    }

    const output = await execPromise(
      `gh pr create \
        --repo ${owner}/${repo} \
        --base dev \
        --head ${branch} \
        --title "${title.replace(/"/g, '\\"')}" \
        --body "${body.replace(/"/g, '\\"')}"`,
    );

    const match = output.stdout.trim().match(/pull\/(\d+)/);
    const prNumber = match ? match[1] : null;

    if (!prNumber) throw new Error('Unable to detect PR number');

    return prNumber;
  } catch (err) {
    // 1. Check if PR already exists
    if (err.message.includes('already exists')) {
      p.note('PR already exists, finding ID...', 'GitHub');
      const view = await execPromise(`gh pr view ${branch} --json number --repo ${owner}/${repo}`);
      return JSON.parse(view.stdout).number;
    }

    // 2. Check if there are no changes to merge (The Fix)
    // GitHub CLI usually says "No commits between dev and branch"
    if (
      err.message.includes('No commits between') ||
      err.stdout?.includes('No commits between') ||
      err.stderr?.includes('No commits between')
    ) {
      return 'NO_CHANGES';
    }

    p.cancel(`Failed to create PR: ${err.message}`);
    process.exit(1);
  }
}

// UPDATED FUNCTION: Skips merge if NO_CHANGES is returned
export async function mergeIntoDev() {
  const branch = (await execGit('git rev-parse --abbrev-ref HEAD')).trim();
  p.note(`Merging ${branch} → dev`, 'Auto-merge');
  const { owner, repo } = await getRepoInfo();

  const prNumber = await createPRToDev(owner, repo, branch);

  // New Check: If no changes, skip the merge step but return successfully
  if (prNumber === 'NO_CHANGES') {
    p.note('Branch is identical to dev. Skipping merge step.', 'Auto-merge');
    return;
  }

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

  try {
    // Ensure we have the latest staging ref for comparison
    await execGit('git fetch origin staging');

    const commits = await getCommitsBetween('origin/staging', 'origin/dev');
    const apiKey = process.env.GEMINI_API_KEY;
    let title = 'Sync dev → staging';
    let body = 'Automated merge by sweet-commit';

    if (commits && apiKey) {
      const prInfo = await generatePRDescription(apiKey, commits);
      title = prInfo.title;
      body = prInfo.body;
    }

    const output = await execPromise(
      `gh pr create \
        --title "${title.replace(/"/g, '\\"')}" \
        --body "${body.replace(/"/g, '\\"')}" \
        --base staging \
        --head dev \
        --label 🤖JARVIS \
        --repo ${owner}/${repo}`,
    );

    const text = output.stdout.trim();
    const urlMatch = text.match(/https:\/\/github\.com\/[^\s]+/);
    const prUrl = urlMatch ? urlMatch[0] : null;

    if (!prUrl) {
      p.note(text, 'Raw gh output');
      throw new Error('Could not detect PR URL from gh output');
    }

    p.note(`Pull Request Created:\n${prUrl}`, 'PR URL');
    return prUrl;
  } catch (err) {
    if (err.message.includes('already exists')) {
      try {
        // Fetch existing PR URL
        const view = await execPromise(
          `gh pr view dev --base staging --json url --repo ${owner}/${repo}`,
        );
        const url = JSON.parse(view.stdout).url;

        // Print the message WITH the clickable URL
        p.note(`PR from dev to staging already exists.\n${url}`, 'PR Exists');
        return url;
      } catch {
        p.note('PR from dev to staging already exists.', 'PR Exists');
        return null;
      }
    }

    p.cancel(`Failed to create PR: ${err.message}`);
    process.exit(1);
  }
}
