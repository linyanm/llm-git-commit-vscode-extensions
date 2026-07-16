const assert = require("node:assert/strict");
const test = require("node:test");
const {
    LlmRequestError,
    buildMessages,
    createChatCompletionsUrl,
    extractCommitMessage,
    getConfigurationError,
    requestCommitMessage,
} = require("../src/commitGenerator");

const configuration = {
    apiBaseUrl: "https://llm.example.com/v1",
    apiKey: "test-key",
    model: "test-model",
    commitStyle: "conventional",
    language: "en",
};

function createResponse({ body = "", ok = true, status = 200, statusText = "OK" } = {}) {
    return {
        ok,
        status,
        statusText,
        text: async () => body,
    };
}

test("creates a chat completions URL from a Base URL", () => {
    assert.equal(
        createChatCompletionsUrl("https://llm.example.com/v1/"),
        "https://llm.example.com/v1/chat/completions"
    );
    assert.equal(
        createChatCompletionsUrl("https://llm.example.com/v1/chat/completions"),
        "https://llm.example.com/v1/chat/completions"
    );
});

test("builds a prompt with the selected format, language, branch, and prioritized commit history", () => {
    const messages = buildMessages("diff --git a/a.js b/a.js", {
        ...configuration,
        commitStyle: "plain",
        language: "zh-CN",
    }, {
        branch: "feature/commit-generation",
        recentCommits: ["feat: add settings", "fix: handle empty diff"],
    });

    assert.match(messages[0].content, /plain-language/);
    assert.match(messages[0].content, /Simplified Chinese/);
    assert.match(messages[0].content, /Recent repository commits are the primary style reference/);
    assert.match(messages[0].content, /Priority order: repository commit-message rules/);
    assert.match(messages[1].content, /Current branch: feature\/commit-generation/);
    assert.match(messages[0].content, /feat: add settings/);
    assert.match(messages[0].content, /fix: handle empty diff/);
    assert.match(messages[1].content, /diff --git/);
});

test("adds a custom prompt to the generation instructions", () => {
    const messages = buildMessages("diff --git a/a.js b/a.js", {
        ...configuration,
        customPrompt: "## Commit rules\n\n- Include the ticket ID in parentheses when one is evident.\n- Keep the scope.",
    });

    assert.match(messages[0].content, /## Commit rules\n\n- Include the ticket ID in parentheses/);
    assert.match(messages[0].content, /\n- Keep the scope\./);
    assert.match(messages[0].content, /Return exactly one commit message/);
});

test("adds the Git input text as a user hint", () => {
    const messages = buildMessages(
        "diff --git a/a.js b/a.js",
        configuration,
        {},
        "  Update the auth scope and reference PROJ-123.  "
    );

    assert.match(messages[1].content, /User hint/);
    assert.match(messages[1].content, /Update the auth scope and reference PROJ-123\./);
});

test("adds repository commit-message rules to the generation instructions", () => {
    const messages = buildMessages("diff --git a/a.js b/a.js", configuration, {
        commitRules: `Source: .commitlintrc.json
{
  "rules": { "type-enum": [2, "always", ["feat", "fix"]] }
}`,
    });

    assert.match(messages[0].content, /Repository commit-message rules/);
    assert.match(messages[0].content, /type-enum/);
    assert.match(messages[0].content, /<repository-commit-rules>/);
});

test("sends an OpenAI-compatible request and extracts the generated message", async () => {
    let request;
    const fetchMock = async (url, options) => {
        request = { url, options };
        return createResponse({ body: JSON.stringify({
            choices: [{ message: { content: "```\nfeat: generate commit messages\n```" } }],
        }) });
    };

    const message = await requestCommitMessage(
        configuration,
        "diff --git a/a.js b/a.js",
        { branch: "main", recentCommits: ["chore: initial commit"] },
        "",
        fetchMock
    );

    assert.equal(message, "feat: generate commit messages");
    assert.equal(request.url, "https://llm.example.com/v1/chat/completions");
    assert.equal(request.options.headers.Authorization, "Bearer test-key");
    assert.equal(JSON.parse(request.options.body).model, "test-model");
    assert.match(JSON.parse(request.options.body).messages[1].content, /Current branch: main/);
});

test("reports missing configuration, empty diffs, and HTTP failures", async () => {
    assert.equal(getConfigurationError({ ...configuration, apiKey: "" }), "API key is missing.");
    assert.throws(() => extractCommitMessage("   "), LlmRequestError);

    await assert.rejects(
        requestCommitMessage(configuration, "", {}, async () => createResponse()),
        /no staged changes/i
    );
    await assert.rejects(
        requestCommitMessage(configuration, "diff", {}, "", async () => createResponse({
            body: JSON.stringify({
            error: { message: "Invalid API key" },
            }),
            ok: false,
            status: 401,
            statusText: "Unauthorized",
        })),
        /401.*Invalid API key/
    );
});
