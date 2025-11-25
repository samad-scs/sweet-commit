import * as p from '@clack/prompts';
import fs from 'fs/promises';
import path from 'path';
import open from 'open';
import clipboardy from 'clipboardy';
import { DIFF_CONFIG } from './config.js';
import {
  checkStagedChanges,
  commitChanges,
  createDevToStagingPR,
  execGit,
  getFileStats,
  getStagedDiff,
  mergeIntoDev,
  syncLocalWithDev,
  pushCurrentBranch,
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

  // Check Changes (Returns boolean)
  const hasChanges = await checkStagedChanges();

  // Handle "No Changes" Scenario
  if (!hasChanges) {
    if (flags.toDev || flags.toStag) {
      p.note(
        'No staged changes found, but merge flags detected. Skipping commit, proceeding to merge.',
        'Workflow',
      );
    } else {
      p.cancel('No staged changes found. Stage your changes first with: git add .');
      process.exit(0);
    }
  }

  // AI Commit Logic (Only if we have changes)
  if (hasChanges) {
    const fileStats = await getFileStats();

    const changesetSize = fileStats.length;
    let sizeDescription = 'small';
    if (changesetSize > 50) sizeDescription = 'very large';
    else if (changesetSize > 20) sizeDescription = 'large';
    else if (changesetSize > 5) sizeDescription = 'medium';

    p.note(
      `Analyzing ${sizeDescription} changeset with ${changesetSize} file${
        changesetSize === 1 ? '' : 's'
      }...`,
      'Changeset Overview',
    );

    const diff = await getStagedDiff();
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
    } else {
      p.cancel('Commit cancelled.');
      process.exit(0);
    }
  }

  // Sync & Merge Logic
  if (flags.toDev || flags.toStag) {
    await syncLocalWithDev();
    await pushCurrentBranch();
    await mergeIntoDev();
  }

  // Staging Logic with Slack Handover
  if (flags.toStag) {
    const prUrl = await createDevToStagingPR();

    // --- UPDATED: Robust Slack Handover ---
    if (prUrl) {
      try {
        // 1. Copy URL to clipboard
        await clipboardy.write(prUrl);
        p.note('PR URL copied to clipboard!', 'Clipboard');

        const teamId = process.env.SLACK_TEAM_ID;
        const channelId = process.env.SLACK_CHANNEL_ID;

        // 2. Construct the URL
        // We use the HTTP redirect because it is more reliable than the slack:// protocol
        // across different OSs (Windows/Mac/Linux).
        let openUrl = 'slack://open';
        let linkText = 'Opening Slack...';

        if (channelId) {
          // This URL is the official way to deep link into a channel
          openUrl = `https://slack.com/app_redirect?channel=${channelId}`;

          // If Team ID is present, it makes it faster/more accurate
          if (teamId) openUrl += `&team=${teamId}`;

          linkText = 'Opening Slack Channel...';
        }

        // 3. Print Clickable Link (ANSI)
        const clickableMessage = `\u001b]8;;${openUrl}\u001b\\${linkText} (Click to Open)\u001b]8;;\u001b\\`;
        p.note(clickableMessage, 'Handover');

        // 4. Trigger Open
        await open(openUrl);
      } catch (error) {
        p.note(`Could not automate Slack/Clipboard: ${error.message}`, 'Manual fallback');
      }
    }
    // ---------------------------------
  }

  p.outro('Done!');
}
