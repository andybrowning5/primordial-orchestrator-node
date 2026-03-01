import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "readline";
import { connect } from "net";

const SOCKET_PATH = "/tmp/_primordial_delegate.sock";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

const anthropic = new Anthropic();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function log(text) {
  process.stderr.write(text + "\n");
}

// --- Socket helpers ---

function socketConnect() {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH, () => resolve(sock));
    sock.on("error", reject);
  });
}

async function socketRequest(msg) {
  const sock = await socketConnect();
  return new Promise((resolve, reject) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx);
        sock.destroy();
        try { resolve(JSON.parse(line)); } catch { resolve({ error: "Invalid JSON" }); }
      }
    });
    sock.on("error", reject);
    sock.on("end", () => {
      if (buf.trim()) {
        try { resolve(JSON.parse(buf.trim())); } catch { resolve({ error: "Invalid JSON" }); }
      } else {
        resolve({ error: "Connection closed" });
      }
    });
    sock.write(JSON.stringify(msg) + "\n");
  });
}

async function* socketStream(msg) {
  const sock = await socketConnect();
  sock.write(JSON.stringify(msg) + "\n");

  const queue = [];
  let resolve;
  let waiting = new Promise((r) => (resolve = r));
  let ended = false;

  const pushLine = (line) => {
    try { queue.push(JSON.parse(line)); } catch {}
    resolve();
    waiting = new Promise((r) => (resolve = r));
  };

  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) pushLine(line);
    }
  });
  sock.on("end", () => { ended = true; resolve(); });
  sock.on("error", () => { ended = true; resolve(); });

  try {
    while (true) {
      if (queue.length === 0 && !ended) await waiting;
      if (queue.length === 0 && ended) return;
      while (queue.length > 0) yield queue.shift();
    }
  } finally {
    sock.destroy();
  }
}

// --- System prompt ---

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

// --- Tools ---

const tools = [
  {
    name: "search_agents",
    description: "Semantic search for agents on the Primordial AgentStore. Returns agents ranked by relevance.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Natural language description of the capability needed" } },
      required: ["query"],
    },
  },
  {
    name: "list_all_agents",
    description: "List all agents on the Primordial AgentStore sorted by popularity.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "start_agent",
    description: "Spawn a sub-agent for multi-turn conversation. Returns a session_id.",
    input_schema: {
      type: "object",
      properties: { agent_url: { type: "string", description: "GitHub URL of the agent to run" } },
      required: ["agent_url"],
    },
  },
  {
    name: "message_agent",
    description: "Send a message to a running sub-agent and get its response.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from start_agent" },
        message: { type: "string", description: "The message to send" },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "monitor_agent",
    description: "View the last 1000 lines of a sub-agent's output.",
    input_schema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Session ID from start_agent" } },
      required: ["session_id"],
    },
  },
  {
    name: "stop_agent",
    description: "Shutdown a sub-agent session. IMPORTANT: Always ask the user for confirmation before calling this.",
    input_schema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Session ID from start_agent" } },
      required: ["session_id"],
    },
  },
];

// --- Tool handlers ---

const toolHandlers = {
  async search_agents({ query }) {
    log(`[orchestrator] searching: ${query}`);
    const resp = await socketRequest({ type: "search", query });
    return JSON.stringify(resp.agents || []);
  },

  async list_all_agents() {
    log("[orchestrator] listing all agents");
    const resp = await socketRequest({ type: "search_all" });
    return JSON.stringify(resp.agents || []);
  },

  async start_agent({ agent_url }, messageId) {
    log(`[orchestrator] starting: ${agent_url}`);
    for await (const event of socketStream({ type: "run", agent_url })) {
      if (event.type === "setup_status") {
        send({ type: "activity", tool: "sub:setup", description: event.status || "", session_id: event.session_id || "", message_id: messageId });
      } else if (event.type === "session") {
        send({ type: "activity", tool: "sub:spawned", description: event.session_id, session_id: event.session_id, message_id: messageId });
        return event.session_id;
      } else if (event.type === "error") {
        return `Error: ${event.error || "unknown"}`;
      }
    }
    return "Error: unexpected end of stream";
  },

  async message_agent({ session_id, message }, messageId) {
    log(`[orchestrator] messaging ${session_id}: ${message}`);
    const activities = [];
    let finalResponse = "";
    for await (const event of socketStream({ type: "message", session_id, content: message })) {
      if (event.type !== "stream_event") continue;
      const inner = event.event || {};
      if (inner.type === "activity") {
        const toolName = inner.tool || "";
        const desc = inner.description || "";
        activities.push({ tool: toolName, description: desc });
        let argsDesc = desc;
        if (desc.startsWith(`${toolName}(`) && desc.endsWith(")")) {
          argsDesc = desc.slice(toolName.length + 1, -1);
        }
        send({ type: "activity", tool: `sub:${toolName}`, description: argsDesc, session_id, message_id: messageId });
      } else if (inner.type === "response" && inner.done) {
        finalResponse = inner.content || "";
        const preview = finalResponse.replace(/\n/g, " ").slice(0, 150).trim();
        send({ type: "activity", tool: "sub:response", description: preview + (finalResponse.length > 150 ? "..." : ""), session_id, message_id: messageId });
        return JSON.stringify({ response: finalResponse, activities });
      }
    }
    return JSON.stringify({ response: finalResponse, activities });
  },

  async monitor_agent({ session_id }) {
    const resp = await socketRequest({ type: "monitor", session_id });
    const lines = resp.lines || [];
    return lines.length ? lines.join("\n") : "No output yet.";
  },

  async stop_agent({ session_id }) {
    log(`[orchestrator] stopping ${session_id}`);
    await socketRequest({ type: "stop", session_id });
    return "Agent stopped.";
  },
};

// --- Agentic loop ---

async function research(content, messageId) {
  const messages = [{ role: "user", content }];

  while (true) {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Emit activity for tool calls
    for (const block of resp.content) {
      if (block.type === "tool_use") {
        const args = block.input || {};
        const q = args.query || args.message || args.agent_url || args.session_id || "";
        send({ type: "activity", tool: block.name, description: q ? `${block.name}(${q})` : block.name, message_id: messageId });
      }
    }

    // If no tool use, return final text
    if (resp.stop_reason === "end_turn" || !resp.content.some((b) => b.type === "tool_use")) {
      return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("") || "";
    }

    // Process tool calls in parallel
    messages.push({ role: "assistant", content: resp.content });

    const toolUseBlocks = resp.content.filter((b) => b.type === "tool_use");
    const settled = await Promise.allSettled(
      toolUseBlocks.map(async (block) => {
        const handler = toolHandlers[block.name];
        if (!handler) return { id: block.id, content: `Error: unknown tool ${block.name}` };
        try {
          const result = await handler(block.input, messageId);
          return { id: block.id, content: typeof result === "string" ? result : JSON.stringify(result) };
        } catch (e) {
          return { id: block.id, content: `Error: ${e.message}` };
        }
      })
    );
    const toolResults = settled.map((s) => {
      const val = s.status === "fulfilled" ? s.value : { id: "unknown", content: `Error: ${s.reason}` };
      return { type: "tool_result", tool_use_id: val.id, content: val.content };
    });
    messages.push({ role: "user", content: toolResults });
  }
}

// --- Primordial Protocol ---

function main() {
  send({ type: "ready" });
  log("Primordial Orchestrator (Node.js) ready");

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;

    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === "shutdown") {
      log("Shutting down");
      rl.close();
      return;
    }

    if (msg.type === "message") {
      const mid = msg.message_id;
      try {
        const result = await research(msg.content, mid);
        send({ type: "response", content: result, message_id: mid, done: true });
      } catch (e) {
        log(`Error: ${e.message}`);
        send({ type: "error", error: e.message, message_id: mid });
        send({ type: "response", content: `Something went wrong: ${e.message}`, message_id: mid, done: true });
      }
    }
  });
}

main();
