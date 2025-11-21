import * as p from '@clack/prompts';
import fs from 'fs/promises';
import path from 'path';
import { DIFF_CONFIG } from './config.js';
import {
  checkStagedChanges,
  commitChanges,
  createDevToStagingPR,
  execGit,
  getFileStats,
  getStagedDiff,
  mergeIntoDev,
} from './git.js';
import { generateCommitMessage } from './utils.js';

// ** Parse Arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {
    addAndPush: false,
    yes: false,
    toDev: false,
    toStag: false,
  };

  for (const a of args) {
    if (a === '--add-and-push' || a === '--ap') flags.addAndPush = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--to-dev') flags.toDev = true;
    else if (a === '--to-stag') flags.toStag = true;
  }
  return flags;
}

async function loadEnvFile() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    const envContent = await fs.readFile(envPath, 'utf8');

    envContent.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').replace(/^["'](.*)["']$/, '$1');
          process.env[key] = value;
        }
      }
    });
  } catch {
    // ignore cleanup error
  }
}

export async function main() {
  process.on('SIGINT', () => {
    p.cancel('Operation cancelled by user.');
    process.exit(130);
  });

  process.on('SIGTERM', () => {
    p.cancel('Operation terminated.');
    process.exit(143);
  });

  process.on('unhandledRejection', (reason) => {
    p.cancel(`Unexpected error: ${reason}`);
    process.exit(1);
  });

  p.intro('sweet-commit');

  await loadEnvFile();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    p.cancel('GEMINI_API_KEY not found. Get your key from: https://aistudio.google.com/app/apikey');
    process.exit(1);
  }

  const flags = parseArgs();

  if (flags.toDev || flags.toStag) {
    flags.addAndPush = true;
    flags.yes = true;
  }

  if (flags.addAndPush) {
    p.note('Flag --add-and-push detected. Running: git add .', 'Auto-add');
    try {
      await execGit('git add .');
    } catch (err) {
      p.cancel(`Failed to run 'git add .': ${err.message}`);
      process.exit(1);
    }
  }

  await checkStagedChanges();

  const fileStats = await getFileStats();

  const changesetSize = fileStats.length;
  let sizeDescription = 'small';
  if (changesetSize > 50) sizeDescription = 'very large';
  else if (changesetSize > 20) sizeDescription = 'large';
  else if (changesetSize > 5) sizeDescription = 'medium';

  p.note(
    `Analyzing ${sizeDescription} changeset with ${changesetSize} file${
      changesetSize === 1 ? '' : 's'
    }...\n` +
      `${fileStats.filter((f) => f.status === 'A').length} added, ` +
      `${fileStats.filter((f) => f.status === 'M').length} modified, ` +
      `${fileStats.filter((f) => f.status === 'D').length} deleted`,
    'Changeset Overview',
  );

  const diff = await getStagedDiff();

  const needsOptimization =
    diff.length > DIFF_CONFIG.maxTokens || diff.startsWith('LARGE_CHANGESET_SUMMARY');
  if (needsOptimization) {
    const sizeMB = Math.round((diff.length / 1024 / 1024) * 100) / 100;

    if (diff.startsWith('LARGE_CHANGESET_SUMMARY')) {
      p.note(
        `Extremely large changeset detected!\n` +
          `Using statistical analysis instead of full diff.\n` +
          `This ensures reliable commit message generation.`,
        'Smart Analysis',
      );
    } else {
      p.note(
        `Large changeset detected (${sizeMB}MB)\n` +
          `Using intelligent summarization to optimize for AI analysis.\n` +
          `Key changes and patterns will be preserved.`,
        'Optimization Active',
      );
    }
  }

  const message = await generateCommitMessage(apiKey, diff);

  p.note(message, 'Generated commit message');

  let shouldCommit = true;
  if (!flags.yes) {
    try {
      shouldCommit = await p.confirm({
        message: 'Commit with this message?',
        initialValue: true,
      });
    } catch {
      p.cancel('Operation cancelled.');
      process.exit(130);
    }
  }

  if (shouldCommit === true) {
    await commitChanges(message);

    // If user requested add-and-push, push now
    if (flags.addAndPush) {
      p.note('Pushing to remote...', 'Auto-push');
      try {
        // try a simple push first
        await execGit('git push');
      } catch (pushErr) {
        // if push failed due to no upstream, try setting upstream
        try {
          const branch = (await execGit('git rev-parse --abbrev-ref HEAD')).trim();
          await execGit(`git push --set-upstream origin ${branch}`);
        } catch {
          p.cancel(`Push failed: ${pushErr.message}`);
          process.exit(1);
        }
      }
    }

    if (flags.toDev || flags.toStag) {
      await mergeIntoDev();
    }

    if (flags.toStag) {
      await createDevToStagingPR();
    }

    p.outro('Done!');
  } else {
    p.cancel('Commit cancelled.');
    process.exit(0);
  }
}
