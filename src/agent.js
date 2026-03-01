import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "readline";
import { connect } from "net";

const SOCKET_PATH = "/tmp/_primordial_delegate.sock";
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are the Primordial Orchestrator. You coordinate specialized agents on the Primordial AgentStore.

## Core Principle

You are a coordinator, not a doer. For every user request, call **list_all_agents** first to see what's available. If any agent is better suited for the task, delegate to it. Only respond directly if no agent fits or it's a simple greeting/clarification.

## Workflow

1. User sends a request → call **list_all_agents** to see available agents.
2. Pick the best agent for the task based on its description.
3. Call **start_agent** with the chosen agent's URL to spawn it.
4. Call **message_agent** with the session ID and the user's request.
5. You can have multi-turn conversations — send follow-up messages to the same session.
6. Use **monitor_agent** to check on sub-agent progress.
7. **Before stopping a sub-agent**, always ask the user for confirmation first.
8. Only call **stop_agent** after the user explicitly approves.

## Rules

- Always list agents before responding to a task — don't guess or skip this.
- If no agent matches, tell the user and attempt it yourself.
- If a task spans multiple domains, start multiple sub-agents.
- Tell the user which agent you're delegating to and why.
- **NEVER stop a sub-agent without asking the user first.** Always confirm before calling stop_agent.`;

const TOOLS = [
  {
    name: "search_agents",
    description: "Search for agents by query string on the AgentStore.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to find agents" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_all_agents",
    description: "List all available agents on the AgentStore.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "start_agent",
    description: "Start a sub-agent by its AgentStore URL. Returns a session_id for further interaction.",
    input_schema: {
      type: "object",
      properties: {
        agent_url: { type: "string", description: "The agent URL to start" },
      },
      required: ["agent_url"],
    },
  },
  {
    name: "message_agent",
    description: "Send a message to a running sub-agent session and get its response.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session ID of the running agent" },
        message: { type: "string", description: "The message to send to the agent" },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "monitor_agent",
    description: "Check the current output/status of a running sub-agent.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session ID to monitor" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop a running sub-agent session. Only call after user confirms.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session ID to stop" },
      },
      required: ["session_id"],
    },
  },
];

// --- Emit helpers ---

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitActivity(tool, description, messageId) {
  emit({ type: "activity", tool, description, message_id: messageId });
}

// --- Socket helpers ---

function _connect() {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH, () => resolve(sock));
    sock.on("error", reject);
  });
}

async function _request(msg) {
  const sock = await _connect();
  return new Promise((resolve, reject) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx);
        sock.destroy();
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ error: "Invalid JSON response" });
        }
      }
    });
    sock.on("error", reject);
    sock.on("end", () => {
      if (buf.trim()) {
        try { resolve(JSON.parse(buf.trim())); } catch { resolve({ error: "Invalid JSON response" }); }
      } else {
        resolve({ error: "Connection closed" });
      }
    });
    sock.write(JSON.stringify(msg) + "\n");
  });
}

async function* _requestStream(msg) {
  const sock = await _connect();
  sock.write(JSON.stringify(msg) + "\n");

  let buf = "";
  const lines = [];
  let done = false;
  let resolveLine;
  let linePromise = new Promise((r) => (resolveLine = r));

  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) lines.push(line.trim());
      resolveLine();
      linePromise = new Promise((r) => (resolveLine = r));
    }
  });

  sock.on("end", () => {
    if (buf.trim()) lines.push(buf.trim());
    done = true;
    resolveLine();
  });

  sock.on("error", () => {
    done = true;
    resolveLine();
  });

  while (true) {
    if (lines.length === 0 && !done) await linePromise;
    if (lines.length === 0 && done) break;
    while (lines.length > 0) {
      const raw = lines.shift();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      yield parsed;
      if (parsed.type === "done" || parsed.type === "error" || (parsed.type && !["stream", "setup_status", "activity"].includes(parsed.type))) {
        sock.destroy();
        return;
      }
    }
  }
  sock.destroy();
}

// --- Tool handlers ---

async function handleSearchAgents(input, messageId) {
  emitActivity("search_agents", `Searching agents: "${input.query}"`, messageId);
  const resp = await _request({ type: "search", query: input.query });
  return JSON.stringify(resp);
}

async function handleListAllAgents(input, messageId) {
  emitActivity("list_all_agents", "Listing all available agents", messageId);
  const resp = await _request({ type: "search_all" });
  return JSON.stringify(resp);
}

async function handleStartAgent(input, messageId) {
  emitActivity("start_agent", `Starting agent: ${input.agent_url}`, messageId);
  let sessionId = null;
  for await (const event of _requestStream({ type: "run", agent_url: input.agent_url })) {
    if (event.type === "setup_status") {
      emitActivity("sub:setup", event.message || event.status || "Setting up...", messageId);
    }
    if (event.session_id) sessionId = event.session_id;
  }
  if (sessionId) return JSON.stringify({ session_id: sessionId });
  return JSON.stringify({ error: "Failed to start agent" });
}

async function handleMessageAgent(input, messageId) {
  emitActivity("message_agent", `Messaging agent session ${input.session_id}`, messageId);
  const activities = [];
  let response = null;
  for await (const event of _requestStream({ type: "message", session_id: input.session_id, content: input.message })) {
    if (event.type === "activity") {
      emitActivity(`sub:${event.tool || "activity"}`, event.description || "", messageId);
      activities.push(event);
    }
    if (event.type === "done" || event.response) {
      response = event.response || event;
    }
  }
  return JSON.stringify({ response, activities });
}

async function handleMonitorAgent(input, messageId) {
  emitActivity("monitor_agent", `Monitoring session ${input.session_id}`, messageId);
  const resp = await _request({ type: "monitor", session_id: input.session_id });
  return JSON.stringify(resp);
}

async function handleStopAgent(input, messageId) {
  emitActivity("stop_agent", `Stopping session ${input.session_id}`, messageId);
  await _request({ type: "stop", session_id: input.session_id });
  return "Agent stopped.";
}

const TOOL_HANDLERS = {
  search_agents: handleSearchAgents,
  list_all_agents: handleListAllAgents,
  start_agent: handleStartAgent,
  message_agent: handleMessageAgent,
  monitor_agent: handleMonitorAgent,
  stop_agent: handleStopAgent,
};

// --- Agentic loop ---

async function handleMessage(userMessage) {
  const client = new Anthropic();
  const messages = [{ role: "user", content: userMessage }];

  while (true) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Collect text and tool_use blocks
    const toolUseBlocks = resp.content.filter((b) => b.type === "tool_use");
    const textBlocks = resp.content.filter((b) => b.type === "text");

    // If no tool calls, we're done — emit final text response
    if (toolUseBlocks.length === 0 || resp.stop_reason === "end_turn") {
      const text = textBlocks.map((b) => b.text).join("\n");
      if (text) emit({ type: "response", content: text });
      // If stop_reason is end_turn, break even if there were tool calls with text
      if (resp.stop_reason === "end_turn" && toolUseBlocks.length === 0) break;
      if (toolUseBlocks.length === 0) break;
    }

    // Process tool calls
    messages.push({ role: "assistant", content: resp.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const handler = TOOL_HANDLERS[block.name];
      let result;
      if (handler) {
        try {
          result = await handler(block.input, block.id);
        } catch (err) {
          result = JSON.stringify({ error: err.message });
        }
      } else {
        result = JSON.stringify({ error: `Unknown tool: ${block.name}` });
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });

    // If end_turn with tool calls, emit text then break
    if (resp.stop_reason === "end_turn") {
      const text = textBlocks.map((b) => b.text).join("\n");
      if (text) emit({ type: "response", content: text });
      break;
    }
  }
}

// --- Stdin/stdout NDJSON protocol ---

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    emit({ type: "error", error: "Invalid JSON input" });
    return;
  }

  if (msg.type === "message" && msg.content) {
    try {
      await handleMessage(msg.content);
    } catch (err) {
      emit({ type: "error", error: err.message });
    }
  }
});
