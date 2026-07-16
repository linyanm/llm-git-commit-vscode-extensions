const REQUEST_TIMEOUT_MS = 60_000;

class LlmRequestError extends Error {
    constructor(message) {
        super(message);
        this.name = "LlmRequestError";
    }
}

function getConfigurationError(configuration) {
    if (!configuration.apiBaseUrl?.trim()) {
        return "API Base URL is missing.";
    }

    if (!configuration.apiKey?.trim()) {
        return "API key is missing.";
    }

    if (!configuration.model?.trim()) {
        return "Model name is missing.";
    }

    return undefined;
}

function createChatCompletionsUrl(apiBaseUrl) {
    const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, "");
    if (!normalizedBaseUrl) {
        throw new LlmRequestError("API Base URL cannot be empty.");
    }

    try {
        const url = new URL(normalizedBaseUrl);
        if (!url.pathname.endsWith("/chat/completions")) {
            url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
        }

        return url.toString();
    } catch {
        throw new LlmRequestError("API Base URL is invalid.");
    }
}

function buildMessages(diff, configuration, gitContext = {}, userInput = "") {
    const styleInstruction = configuration.commitStyle === "plain"
        ? "Write a concise plain-language commit message."
        : "Use Conventional Commits format, such as feat: add commit generator.";
    const languageInstruction = configuration.language === "zh-CN"
        ? "Write the message in Simplified Chinese."
        : "Write the message in English.";
    const customPrompt = configuration.customPrompt?.trim();
    const normalizedUserInput = typeof userInput === "string" ? userInput.trim() : "";
    const commitRules = gitContext.commitRules?.trim();
    const branch = gitContext.branch || "unknown";
    const recentCommits = gitContext.recentCommits?.length
        ? gitContext.recentCommits.map((message) => `- ${message}`).join("\n")
        : "";

    const userContentParts = [
        `Current branch: ${branch}`,
    ];

    if (normalizedUserInput) {
        userContentParts.push(
            "User hint (the user started typing this — use it as a reference for the commit intent, scope, or direction):",
            normalizedUserInput
        );
    }

    userContentParts.push("Staged diff:", diff);

    const systemInstructions = [
        "You generate Git commit messages from staged diffs.",
        styleInstruction,
        languageInstruction,
    ];

    if (customPrompt) {
        systemInstructions.push(`Additional user instructions: ${customPrompt}`);
    }

    if (commitRules) {
        systemInstructions.push([
            "Repository commit-message rules (follow these when they are more specific than the selected style):",
            "<repository-commit-rules>",
            commitRules,
            "</repository-commit-rules>",
        ].join("\n"));
    }

    if (recentCommits) {
        systemInstructions.push([
            "Recent repository commits are the primary style reference. Closely match their format, language, scope convention, and tone unless this conflicts with repository rules or custom instructions:",
            "<recent-commit-messages>",
            recentCommits,
            "</recent-commit-messages>",
        ].join("\n"));
    }

    systemInstructions.push(
        "Priority order: repository commit-message rules, custom instructions, recent commit-message style, then the selected style and language defaults. A user hint describes commit intent and does not override the preceding style rules."
    );

    systemInstructions.push(
        "Return exactly one commit message without Markdown, quotation marks, explanation, or code fences."
    );

    return [
        {
            role: "system",
            content: systemInstructions.join(" "),
        },
        {
            role: "user",
            content: userContentParts.join("\n\n"),
        },
    ];
}

function extractCommitMessage(content) {
    const rawContent = Array.isArray(content)
        ? content.map((part) => part?.text ?? "").join("")
        : content;
    if (typeof rawContent !== "string") {
        throw new LlmRequestError("The LLM response format is not supported.");
    }

    const normalized = rawContent
        .trim()
        .replace(/^```(?:\w+)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    const firstLine = normalized.split(/\r?\n/).find((line) => line.trim());
    const commitMessage = firstLine
        ?.trim()
        .replace(/^commit\s+message\s*:\s*/i, "")
        .replace(/^['"`]|['"`]$/g, "")
        .trim();

    if (!commitMessage) {
        throw new LlmRequestError("The LLM did not return a valid commit message.");
    }

    return commitMessage;
}

async function requestCommitMessage(
    configuration,
    diff,
    gitContext = {},
    userInput = "",
    fetchImpl = globalThis.fetch
) {
    const configurationError = getConfigurationError(configuration);
    if (configurationError) {
        throw new LlmRequestError(configurationError);
    }

    if (!diff?.trim()) {
        throw new LlmRequestError("There are no staged changes to generate a commit message from.");
    }

    if (typeof fetchImpl !== "function") {
        throw new LlmRequestError("The current VS Code runtime does not support network requests.");
    }

    let response;
    try {
        response = await fetchImpl(createChatCompletionsUrl(configuration.apiBaseUrl), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${configuration.apiKey.trim()}`,
            },
            body: JSON.stringify({
                model: configuration.model.trim(),
                messages: buildMessages(diff, configuration, gitContext, userInput),
                temperature: 0.2,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
            throw new LlmRequestError("The LLM request timed out. Please try again.");
        }

        throw new LlmRequestError(`Could not connect to the LLM service: ${error instanceof Error ? error.message : String(error)}`);
    }

    const responseText = await response.text();
    let payload;
    try {
        payload = responseText ? JSON.parse(responseText) : undefined;
    } catch {
        throw new LlmRequestError("The LLM service returned an invalid JSON response.");
    }

    if (!response.ok) {
        const detail = payload?.error?.message || response.statusText || `HTTP ${response.status}`;
        throw new LlmRequestError(`LLM request failed (${response.status}): ${detail}`);
    }

    return extractCommitMessage(payload?.choices?.[0]?.message?.content);
}

module.exports = {
    LlmRequestError,
    buildMessages,
    createChatCompletionsUrl,
    extractCommitMessage,
    getConfigurationError,
    requestCommitMessage,
};
