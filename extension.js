const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
    LlmRequestError,
    getConfigurationError,
    requestCommitMessage,
} = require("./src/commitGenerator");

const EXTENSION_IDENTIFIER = "linyanm.llm-git-commit-vscode-extensions";
const MAX_COMMIT_RULES_LENGTH = 12_000;
const COMMITLINT_CONFIG_FILES = [
    ".commitlintrc",
    ".commitlintrc.json",
    ".commitlintrc.yaml",
    ".commitlintrc.yml",
    ".commitlintrc.js",
    ".commitlintrc.cjs",
    ".commitlintrc.mjs",
    "commitlint.config.js",
    "commitlint.config.cjs",
    "commitlint.config.mjs",
    "commitlint.config.ts",
    "commitlint.config.cts",
    "commitlint.config.mts",
    "commitlint.config.json",
    "commitlint.config.yaml",
    "commitlint.config.yml",
];

let isGenerating = false;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const outputChannel = vscode.window.createOutputChannel("LLM Git Commit");

    const generateCommitMessage = vscode.commands.registerCommand(
        "llm-git-commit.generateCommitMessage",
        async () => {
            if (isGenerating) {
                void vscode.window.showInformationMessage("Generating a commit message. Please wait.");
                return;
            }

            const configuration = getLlmConfiguration();
            const configurationError = getConfigurationError(configuration);
            if (configurationError) {
                const action = await vscode.window.showErrorMessage(
                    `${configurationError} Configure LLM Git Commit before generating a message.`,
                    "Open Settings"
                );

                if (action === "Open Settings") {
                    await openSettings();
                }

                return;
            }

            isGenerating = true;
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "LLM Git Commit: Generating commit message",
                    cancellable: false,
                }, async () => {
                    const repository = await selectRepository();
                    if (!repository) {
                        return;
                    }

                    const stagedDiff = await repository.diff(true);
                    if (!stagedDiff.trim()) {
                        void vscode.window.showWarningMessage(
                            "No staged changes found. Stage the files you want to commit first."
                        );
                        return;
                    }

                    const gitContext = await getGitContext(repository);
                    if (gitContext.commitRuleSources.length) {
                        outputChannel.appendLine(
                            `Loaded commit-message rules from: ${gitContext.commitRuleSources.join(", ")}.`
                        );
                    }
                    const inputBoxValue = repository.inputBox.value;
                    const userHint = inputBoxValue.trim();
                    outputChannel.appendLine("Generating a commit message from staged changes.");
                    const commitMessage = await requestCommitMessage(
                        configuration,
                        stagedDiff,
                        gitContext,
                        userHint
                    );

                    if (repository.inputBox.value !== inputBoxValue) {
                        outputChannel.appendLine(
                            "The Git input changed while generating; the generated message was not applied."
                        );
                        const action = await vscode.window.showWarningMessage(
                            "The Git input changed while generating, so the generated message was not applied.",
                            "Copy Generated Message"
                        );
                        if (action === "Copy Generated Message") {
                            await vscode.env.clipboard.writeText(commitMessage);
                        }
                        return;
                    }

                    repository.inputBox.value = commitMessage;
                    outputChannel.appendLine("Commit message generated successfully.");
                    void vscode.window.showInformationMessage("Commit message generated and added to the Git input box.");
                });
            } catch (error) {
                const message = error instanceof LlmRequestError
                    ? error.message
                    : `Failed to generate commit message: ${error instanceof Error ? error.message : String(error)}`;
                outputChannel.appendLine(`Generation failed: ${message}`);
                void vscode.window.showErrorMessage(message);
            } finally {
                isGenerating = false;
            }
        }
    );

    const openSettingsCommand = vscode.commands.registerCommand(
        "llm-git-commit.openSettings",
        openSettings
    );

    context.subscriptions.push(outputChannel, generateCommitMessage, openSettingsCommand);
}

async function getGitContext(repository) {
    const [logEntries, commitRules] = await Promise.all([
        repository.log({ maxEntries: 10 }),
        getCommitRules(repository.rootUri.fsPath),
    ]);

    return {
        branch: repository.state.HEAD?.name || "detached HEAD",
        recentCommits: logEntries
            .map((entry) => entry.message.split(/\r?\n/, 1)[0].trim())
            .filter(Boolean)
            .slice(0, 10),
        commitRules: commitRules.content,
        commitRuleSources: commitRules.sources,
    };
}

async function getCommitRules(repositoryRoot) {
    const sources = [];
    const ruleParts = [];

    for (const fileName of COMMITLINT_CONFIG_FILES) {
        const content = await readTextFile(path.join(repositoryRoot, fileName));
        if (content?.trim()) {
            sources.push(fileName);
            ruleParts.push({ source: fileName, content: content.trim() });
        }
    }

    const packageJson = await readTextFile(path.join(repositoryRoot, "package.json"));
    if (packageJson) {
        try {
            const commitlintConfig = JSON.parse(packageJson).commitlint;
            if (commitlintConfig && typeof commitlintConfig === "object") {
                sources.push("package.json#commitlint");
                ruleParts.push({
                    source: "package.json#commitlint",
                    content: JSON.stringify(commitlintConfig, null, 2),
                });
            }
        } catch {
            // Ignore an invalid package.json and continue generation without these optional rules.
        }
    }

    let remainingLength = MAX_COMMIT_RULES_LENGTH;
    const content = [];
    for (const rulePart of ruleParts) {
        if (remainingLength <= 0) {
            content.push("Repository commit-message rules were truncated.");
            break;
        }

        const formattedRulePart = `Source: ${rulePart.source}\n${rulePart.content}`;
        content.push(formattedRulePart.slice(0, remainingLength));
        remainingLength -= formattedRulePart.length;
    }

    return {
        content: content.join("\n\n"),
        sources,
    };
}

async function readTextFile(filePath) {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch {
        return undefined;
    }
}

function getLlmConfiguration() {
    const configuration = vscode.workspace.getConfiguration("llmGitCommit");

    return {
        apiBaseUrl: configuration.get("apiBaseUrl", ""),
        apiKey: configuration.get("apiKey", ""),
        model: configuration.get("model", ""),
        commitStyle: configuration.get("commitStyle", "conventional"),
        language: configuration.get("language", "en"),
        customPrompt: configuration.get("customPrompt", ""),
    };
}

async function selectRepository() {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
        throw new Error("The built-in VS Code Git extension was not found.");
    }

    const gitExports = gitExtension.isActive
        ? gitExtension.exports
        : await gitExtension.activate();
    const git = gitExports.getAPI(1);
    const repositories = git.repositories;

    if (repositories.length === 0) {
        throw new Error("No Git repository is open in the current workspace.");
    }

    if (repositories.length === 1) {
        return repositories[0];
    }

    const selected = await vscode.window.showQuickPick(
        repositories.map((repository) => ({
            label: vscode.workspace.asRelativePath(repository.rootUri, false),
            description: repository.rootUri.fsPath,
            repository,
        })),
        {
            placeHolder: "Select the Git repository for commit message generation",
        }
    );

    return selected?.repository;
}

function openSettings() {
    return vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${EXTENSION_IDENTIFIER}`
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
};
