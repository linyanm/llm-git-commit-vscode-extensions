# LLM Git Commit

Generate Git commit messages from staged changes in VS Code.

The extension reads staged changes in the current Git repository, sends them to an OpenAI-compatible LLM, and fills the generated message into VS Code's Git input box. It never commits automatically.

## Development

```bash
npm install
```

Open this repository in VS Code and press `F5` to start an Extension Development Host. Stage at least one file, then click ✨ in the Source Control title bar or run `LLM Git Commit: Generate Commit Message` from the Command Palette.

## Commands

| Command | Description |
| --- | --- |
| `LLM Git Commit: Generate Commit Message` | Generate a commit message from the staged diff and add it to the Git input box |
| `LLM Git Commit: Open Settings` | Open the extension settings |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `llmGitCommit.model` | `""` | LLM model name |
| `llmGitCommit.apiBaseUrl` | `""` | OpenAI-compatible API Base URL, such as `https://api.openai.com/v1` |
| `llmGitCommit.apiKey` | `""` | OpenAI-compatible API key |
| `llmGitCommit.commitStyle` | `conventional` | Conventional Commits or a plain-language format |
| `llmGitCommit.language` | `en` | Output language |
| `llmGitCommit.customPrompt` | `""` | Extra instructions for generated messages, such as requiring an issue number, scope, or tone |

`apiKey` is stored as plain text in your local VS Code `settings.json` and marked machine-local. Never commit, screenshot, or share a settings file that contains this key.

`customPrompt` is a multiline text area in the Settings UI. Line breaks and Markdown syntax are preserved when sent to the LLM, though the extension does not render Markdown itself. For example:

```markdown
## Commit rules

- Use a Conventional Commit scope when it is clear from the changes.
- Include the related issue number in parentheses if one appears in the diff.
```

When editing `settings.json` directly, write line breaks as `\n` inside the JSON string.

## Behavior

- The staged diff, current branch name, and the subject lines of the 10 most recent commits are sent to the LLM; unstaged changes are excluded. Recent commits are the primary style reference, after Commitlint rules and `customPrompt`.
- When present at the Git repository root, Commitlint configuration is included in the generation instructions. The extension reads `.commitlintrc*`, `commitlint.config.*`, and the `commitlint` field in `package.json`; it does not execute repository configuration files.
- Text already entered in the Git commit input box is sent as a hint for the commit intent, scope, or direction. If you edit that input while generation is in progress, the extension preserves your edit instead of overwriting it; you can copy the generated message from the notification.
- If the workspace has multiple Git repositories, the extension asks you to select one.
- Missing configuration, generation failures, and API errors do not change the current commit message.
- This first version uses the OpenAI-compatible `/chat/completions` endpoint and does not support streaming or custom response mappings.
