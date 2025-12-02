import { GoogleGenAI } from '@google/genai';
import { DIFF_CONFIG } from './config.js';
import * as p from '@clack/prompts';

export function analyzeDiffContent(diff) {
  const lines = diff.split('\n');
  const analysis = {
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    summary: [],
  };

  let currentFile = null;
  let additions = 0;
  let deletions = 0;
  let contextLines = [];

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        analysis.files.push({
          ...currentFile,
          additions,
          deletions,
          context: contextLines.slice(-DIFF_CONFIG.maxContextLines),
        });
      }

      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      currentFile = {
        path: match ? match[1] : 'unknown',
        type: 'modified',
      };
      additions = 0;
      deletions = 0;
      contextLines = [];
    } else if (line.startsWith('new file mode')) {
      if (currentFile) currentFile.type = 'added';
    } else if (line.startsWith('deleted file mode')) {
      if (currentFile) currentFile.type = 'deleted';
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
      analysis.totalAdditions++;
      if (line.length < DIFF_CONFIG.maxContextLineLength) {
        contextLines.push(line);
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
      analysis.totalDeletions++;
      if (line.length < DIFF_CONFIG.maxContextLineLength) {
        contextLines.push(line);
      }
    } else if (line.startsWith('@@')) {
      contextLines.push(line);
    }
  }

  if (currentFile) {
    analysis.files.push({
      ...currentFile,
      additions,
      deletions,
      context: contextLines.slice(-DIFF_CONFIG.maxContextLines),
    });
  }

  return analysis;
}

export function createOptimizedDiff(originalDiff) {
  if (originalDiff.startsWith('LARGE_CHANGESET_SUMMARY')) {
    return originalDiff.replace(
      'LARGE_CHANGESET_SUMMARY\n\n',
      'Extremely large changeset - statistical summary:\n\n',
    );
  }

  if (originalDiff.length < DIFF_CONFIG.maxTokens) {
    return originalDiff;
  }

  const analysis = analyzeDiffContent(originalDiff);

  let optimizedDiff = `Files changed: ${analysis.files.length}\n`;
  optimizedDiff += `Total additions: +${analysis.totalAdditions}, deletions: -${analysis.totalDeletions}\n\n`;

  const filesToShow = analysis.files.slice(0, DIFF_CONFIG.maxFilesInSummary);

  for (const file of filesToShow) {
    optimizedDiff += `File: ${file.path} (${file.type})\n`;
    optimizedDiff += `Changes: +${file.additions} -${file.deletions}\n`;

    if (file.context.length > 0) {
      optimizedDiff += `Key changes:\n`;
      file.context.slice(0, 5).forEach((line) => {
        optimizedDiff += `  ${line}\n`;
      });
    }
    optimizedDiff += '\n';

    if (optimizedDiff.length > DIFF_CONFIG.maxTokens * 0.8) break;
  }

  if (analysis.files.length > filesToShow.length) {
    optimizedDiff += `... and ${analysis.files.length - filesToShow.length} more files\n\n`;
  }

  if (optimizedDiff.length > DIFF_CONFIG.maxTokens) {
    const fileTypes = {};
    analysis.files.forEach((f) => {
      const ext = f.path.split('.').pop() || 'other';
      if (!fileTypes[ext]) fileTypes[ext] = { count: 0, additions: 0, deletions: 0, files: [] };
      fileTypes[ext].count++;
      fileTypes[ext].additions += f.additions;
      fileTypes[ext].deletions += f.deletions;
      fileTypes[ext].files.push(f.path);
    });

    optimizedDiff = `Large changeset summary:\n`;
    optimizedDiff += `Total files: ${analysis.files.length}\n`;
    optimizedDiff += `Total changes: +${analysis.totalAdditions} -${analysis.totalDeletions} lines\n\n`;

    optimizedDiff += `File types affected:\n`;
    Object.entries(fileTypes).forEach(([type, info]) => {
      optimizedDiff += `  ${type}: ${info.count} files (+${info.additions}/-${info.deletions})\n`;
      if (info.files.length <= 3) {
        optimizedDiff += `    Files: ${info.files.join(', ')}\n`;
      } else {
        optimizedDiff += `    Files: ${info.files.slice(0, 2).join(', ')}, ...and ${
          info.files.length - 2
        } more\n`;
      }
    });

    const significantFiles = analysis.files
      .filter((f) => f.additions + f.deletions > 5)
      .slice(0, 3);

    if (significantFiles.length > 0) {
      optimizedDiff += `\nMajor changes:\n`;
      significantFiles.forEach((file) => {
        optimizedDiff += `  ${file.path}: ${file.type} (+${file.additions}/-${file.deletions})\n`;
      });
    }
  }

  return optimizedDiff;
}

export async function generateCommitMessage(apiKey, diff) {
  const spinner = p.spinner();
  spinner.start('Analyzing changes and generating commit message...');

  try {
    const client = new GoogleGenAI({ apiKey });

    const optimizedDiff = createOptimizedDiff(diff);
    const isOptimized = optimizedDiff !== diff;

    if (isOptimized) {
      spinner.message('Large changeset detected, using optimized analysis...');
    }

    const prompt = `Generate a conventional commit message based on this git ${
      isOptimized ? 'change summary' : 'diff'
    }.

Rules:
- Use conventional commit format: type(scope): description
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build
- Keep description under 50 characters
- Use imperative mood (add, fix, update, not added, fixed, updated)
- Add a body with bullet points if needed, max 72 chars per line
- No markdown formatting, just plain text
${
  isOptimized ? '- This is a summarized view of a large changeset, focus on the overall impact' : ''
}

${isOptimized ? 'Change summary' : 'Git diff'}:
${optimizedDiff}

Return only the commit message, nothing else.`;

    const result = await client.models.generateContent({
      model: 'gemini-2.0-flash-001',
      contents: prompt,
    });

    let message = result.text.trim();

    message = message.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '');
    message = message.replace(/\*\*(.*?)\*\*/g, '$1');

    spinner.stop('Commit message generated!');
    return message;
  } catch (error) {
    spinner.stop('Failed to generate commit message.');

    let userFriendlyMessage = 'Unable to generate commit message';

    if (error.message.includes('API key')) {
      userFriendlyMessage = 'Invalid API key. Please check your GEMINI_API_KEY.';
    } else if (error.message.includes('quota') || error.message.includes('limit')) {
      userFriendlyMessage =
        'API quota exceeded. Please try again later or check your Gemini API usage.';
    } else if (error.message.includes('network') || error.message.includes('fetch')) {
      userFriendlyMessage = 'Network error. Please check your internet connection and try again.';
    } else if (error.message.includes('token')) {
      userFriendlyMessage =
        'Changeset too complex for AI analysis. Try breaking it into smaller commits.';
    } else {
      userFriendlyMessage = `AI service error: ${error.message}`;
    }

    p.cancel(userFriendlyMessage);
    process.exit(1);
  }
}

export async function generatePRDescription(apiKey, commits, fallbackContext = null) {
  const spinner = p.spinner();
  spinner.start('Generating PR description...');

  try {
    const client = new GoogleGenAI({ apiKey });

    const prompt = `Generate a Pull Request Title and Body based on these commits.

Commits:
${commits}

Rules:
1. Title: concise, imperative, max 70 chars. Format: "Type: Title" (e.g., "Feat: Add user login").
2. Body: Markdown format.
   - Brief summary of changes.
   - Bullet points for key updates.
   - Mention any breaking changes if likely.
3. Output JSON format: { "title": "...", "body": "..." }
4. Do not include markdown code blocks in the output, just the raw JSON string.`;

    const result = await client.models.generateContent({
      model: 'gemini-2.0-flash-001',
      contents: prompt,
    });

    let text = result.text.trim();
    // Clean up potential markdown code blocks if the model ignores the rule
    text = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');

    const json = JSON.parse(text);

    spinner.stop('PR description generated!');
    return json;
  } catch {
    spinner.stop('Failed to generate PR description. Using defaults.');

    if (fallbackContext) {
      return {
        title: fallbackContext.title,
        body: fallbackContext.body,
      };
    }

    return {
      title: 'Automated Sync',
      body: 'Automated merge by sweet-commit.\n\nCommits:\n' + commits,
    };
  }
}
