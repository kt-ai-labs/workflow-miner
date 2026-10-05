# Discovery

This document records competitive and technical discovery for Workflow Miner before committing to provider-specific implementation.

The goal is to reuse existing session infrastructure where it is sufficient and keep Workflow Miner focused on the missing layer: repeated-friction detection, coverage analysis, and actionable infrastructure recommendations.

## 1. VS Code Agents, Agent Host Protocol (AHP), and OpenTelemetry

**Status:** promising ingestion source; validate before building native Claude/Codex adapters.

**Researched:** 2026-10-05.

### What VS Code already provides

VS Code now has a dedicated **Agents window** backed by a separate **Agent Host** process. The Agent Host can run multiple agent harnesses behind one client-facing session model, including Copilot, Claude, and Codex.

The important architectural boundary is:

```text
Claude / Codex / Copilot harnesses
             ↓
      VS Code Agent Host
             ↓
 Agent Host Protocol (AHP)
             ↓
       arbitrary clients
```

Each provider keeps its own runtime, tools, permissions, hooks, and agent loop. The Agent Host adapter maps those provider-native events into AHP session/chat/tool-call state.

AHP is open source and MIT licensed.

Sources:

- VS Code Agent Host: https://code.visualstudio.com/docs/agents/concepts/agent-host
- Agent harnesses: https://code.visualstudio.com/docs/agents/run/agent-harnesses
- AHP repository: https://github.com/microsoft/agent-host-protocol
- AHP doctrine: https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/doctrine.md

### AHP is useful for Workflow Miner because it is already provider-neutral

AHP exposes a common model for:

- session provider
- working directories
- session/chat timestamps and status
- user turns and agent turns
- tool-call lifecycle
- tool confirmations and failures
- changesets
- older-turn pagination
- lazy references for large content

The protocol intentionally separates session metadata from chat history. A client can:

1. connect and subscribe to `ahp-root://`;
2. call `listSessions` (paginated);
3. subscribe to a selected `ahp-session:/...`;
4. subscribe to its `ahp-chat:/...` channels;
5. request a bounded recent-turn window and page older turns only when needed.

This is a good fit for Workflow Miner's token-efficiency requirement: discovery can operate on lightweight session summaries first and load detailed turns only for sessions that pass the local scope gate.

Sources:

- Root/session catalogue: https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/root-channel.md
- Session state: https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/session-channel.md
- TypeScript client: https://github.com/microsoft/agent-host-protocol/blob/main/clients/typescript/README.md

### Important finding: VS Code can discover native Claude Code and Codex sessions

This materially changes the original Workflow Miner design.

VS Code can discover supported sessions created **outside VS Code**, including Claude Code and Codex. Those sessions appear as external sessions. When the user sends a message from VS Code, the Agent Host adopts the session.

The VS Code Agent Host implementation confirms that Claude and Codex providers enumerate their native session catalogs and register unknown sessions as external sessions. In other words, Microsoft already has provider-specific native-session discovery code for both providers.

This means an AHP-based Workflow Miner may be able to consume historical/native Claude and Codex work through one normalized interface instead of maintaining our own JSONL parsers.

Sources:

- Session concepts: https://code.visualstudio.com/docs/agents/concepts/sessions
- Managing external sessions: https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions
- Agent Host implementation notes: https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/AGENTS.md

### External-session discovery is not yet a stable enough dependency to trust blindly

The feature is still moving quickly.

Recent VS Code issues document gaps around rediscovering external sessions created after Agent Host startup. Newer work has added live watching for Codex session storage, but this area is still actively changing.

Workflow Miner therefore should not assume that the AHP catalogue is always a complete historical corpus without validating it against the native provider stores.

For an initial spike, compare:

```text
AHP listSessions count / IDs
vs.
native Claude session catalogue
vs.
native Codex session catalogue
```

and record any missing-session classes.

Relevant issues:

- External discovery startup limitation: https://github.com/microsoft/vscode/issues/335215
- Codex live discovery follow-up: https://github.com/microsoft/vscode/issues/338394

### Local third-party access is explicitly supported

VS Code publishes a discoverable local Agent Host endpoint for other processes running as the same OS user.

Endpoint metadata is written below the active VS Code user-data directory:

```text
<userDataPath>/agent-host/local-endpoint/entries/<identity>.json
```

The entry contains:

- protocol version
- process identity
- endpoint type/address
- a connection token

The editor endpoint currently uses WebSocket framing over a Unix-domain socket on macOS/Linux or a named pipe on Windows. Standalone `code agent host` can expose TCP.

This is a real supported integration seam, not reverse engineering of private Claude/Codex storage.

Security is local-user scoped: registry files are owner-only and the WebSocket upgrade requires the published connection token.

Source:

- https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/LOCAL_ENDPOINT.md

### Official TypeScript client already exists

Microsoft publishes:

```text
@microsoft/agent-host-protocol
```

The package works on Node 21+ and provides:

- protocol wire types and reducers;
- `AhpClient`;
- state mirrors/subscription management;
- multi-host support;
- WebSocket transport.

Workflow Miner already targets Node 22+, so the runtime requirement fits.

There is also an existing community CLI/Node client, **AHPX**, which is worth evaluating before implementing local endpoint/transport plumbing ourselves.

Sources:

- https://github.com/microsoft/agent-host-protocol/blob/main/clients/typescript/README.md
- https://microsoft.github.io/agent-host-protocol/guide/implementations.html

### OpenTelemetry is a second possible normalized input

Agent Host has a separate OTel pipeline for native Copilot, Claude, and Codex runtimes.

It can:

- export traces to an OTLP collector;
- write JSON-lines trace output;
- persist traces in a local SQLite database;
- correlate provider-native traces with Agent Host sessions.

Provider identity remains visible through native `service.name` values such as `claude-code` and `codex-app-server`.

This is interesting for Workflow Miner because it provides a standardized stream of timing, token, tool, and error telemetry without reading provider JSONL directly.

However:

- Agent Host OTel is currently documented as Insiders/non-stable;
- OTel is disabled by default;
- prompt/response content capture is disabled by default;
- enabling content capture can include sensitive prompts, code, tool arguments, and tool results.

Therefore OTel looks useful as an **optional evidence/diagnostics source**, but it should not be the only V1 ingestion path.

Sources:

- Agent Host OTel pipeline: https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/OTEL.md
- Agent Debug Logs export/import: https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view

### How this interacts with Workflow Miner's privacy boundary

AHP does not replace Workflow Miner's explicit allowlist.

AHP `listSessions` currently does not define repository/path filtering suitable for our privacy policy. Workflow Miner must still apply its own **default-deny scope gate** using session working-directory metadata before loading detailed chat history or producing evidence.

Expected flow:

```text
AHP session catalogue
        ↓
read lightweight working-directory metadata
        ↓
Workflow Miner include/exclude scope gate
        ↓
only allowed sessions
        ↓
subscribe/load turns
        ↓
reduce into Workflow Miner evidence
```

If the session cannot be attributed to an allowed path with sufficient confidence, shared extraction should fail closed.

See [scope.md](./scope.md).

### What AHP does not solve for us

AHP is deliberately a **client-facing presentation model**, not a raw provider event archive.

That has two consequences:

1. It may normalize away provider-specific details that could occasionally matter for mining.
2. Large tool content may be lazy or omitted unless explicitly fetched.

For Workflow Miner, this is mostly beneficial because we want compact interaction evidence, not raw execution dumps. But we still need a native fallback if experiments show that important correction/retry/tool context is lost.

AHP also does **not** solve the core product problem:

- detecting repeated human corrections and steering;
- clustering semantically equivalent friction across projects/providers/users;
- scanning existing AGENTS.md, skills, scripts, hooks, configs, and docs;
- deciding whether a candidate is already covered, partially covered, conflicting, or missing;
- selecting the smallest durable destination;
- producing an evidence-backed automation backlog.

That remains Workflow Miner's differentiating layer.

### Provisional recommendation

**Do not implement Claude and Codex native parsers yet.**

Before investing in `packages/providers/claude` and `packages/providers/codex`, run a small AHP ingestion spike.

The preferred architecture, if the spike succeeds, becomes:

```text
VS Code Agent Host
  ├─ Claude native sessions
  ├─ Codex native sessions
  └─ future supported harnesses
             ↓
             AHP
             ↓
packages/providers/ahp
             ↓
Workflow Miner reduction / evidence
             ↓
friction mining + coverage analysis
```

Native Claude/Codex providers would then be fallback adapters for environments where AHP is unavailable or incomplete, not the primary path.

### Concrete validation spike

Do this before changing package architecture:

1. Start VS Code Agent Host with external sessions enabled.
2. Ensure at least one native Claude Code session and one native Codex session are visible.
3. Connect from a small external Node process using AHP (or AHPX if it already solves endpoint discovery/transport).
4. Call `listSessions` and inspect provider + working-directory metadata.
5. Apply the Workflow Miner allowlist **before** subscribing to chat history.
6. For one Claude and one Codex session, load:
   - user turns;
   - agent turns;
   - tool-call names/input summaries;
   - failures/confirmations;
   - timestamps;
   - working directory;
   - available changeset metadata.
7. Compare the AHP representation with the corresponding native provider transcript.
8. Record exactly what information is lost, normalized, or unavailable.
9. Measure size reduction from native transcript to the AHP-derived representation.
10. Repeat with an external session created after Agent Host startup to test discovery freshness.

### Decision criterion

Prefer AHP as the primary ingestion provider if it can reliably recover the interaction evidence needed for workflow mining while reducing provider-specific code.

Only add native Claude/Codex ingestion where a concrete, demonstrated information or availability gap remains.
