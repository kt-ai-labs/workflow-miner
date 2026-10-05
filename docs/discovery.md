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


### Discovery harness added

The bootstrap branch now contains a small research harness at `discovery/ahp-sessions.ts`.

It uses the official `@microsoft/agent-host-protocol` client together with `ws` for VS Code's local socket/named-pipe WebSocket endpoint. The script:

- discovers live Agent Host endpoint registry entries;
- negotiates AHP;
- paginates `listSessions`;
- prints provider, project, working-directory, timestamp, title, and resource metadata;
- filters by provider, project name, include roots, and exclude roots;
- sorts without loading transcript content.

The AHP libraries are currently **root devDependencies**, not a workspace package dependency. This is intentional: the code is a technical spike. If the experiment validates AHP as the primary ingestion seam, it can then graduate into a real provider package.

## 2. AgentsView

**Status:** very strong candidate for the ingestion, normalization, indexing, and local-storage layer; validate its programmatic surfaces before building provider parsers.

**Researched:** 2026-10-05.

### Question

Can AgentsView eliminate Workflow Miner's provider-specific ingestion/index/storage layer so that Workflow Miner can focus on repeated friction, coverage analysis, and durable automation recommendations?

The provisional answer is **probably yes for most of that layer**.

AgentsView is a local-first, MIT-licensed session archive with a mature provider/parser subsystem. Its current release documents support for more than 60 agent formats, including Claude Code and Codex. It discovers native provider session stores, parses them into one normalized archive, watches for changes, and exposes the resulting data through a web UI, CLI, REST API, and MCP server.

Sources:

- https://www.agentsview.io/
- https://github.com/kenn-io/agentsview
- https://www.agentsview.io/docs/session-api/

### AgentsView already owns the hard provider-specific mechanics

The source tree contains dedicated provider implementations for Claude, Codex, Cursor, Copilot, and many other agents.

Its provider abstraction is substantially more than a JSONL decoder. Providers own:

- source discovery;
- source identity and fingerprints;
- full and incremental parsing;
- watch roots and changed-path handling;
- source freshness;
- multi-file/container formats;
- reconciliation and deletion authority;
- provider-specific topology;
- subagent/session identity.

The sync engine then normalizes provider output into common session/message/tool-call records.

The normalized session model includes, among other fields:

- session ID and native source identity;
- agent/provider;
- project;
- machine;
- working directory;
- Git branch;
- parent/subagent relationship;
- timestamps;
- message/user-message counts;
- truncation and termination state;
- source metadata and parser diagnostics.

Normalized messages preserve:

- role;
- visible content;
- thinking text where retained;
- timestamp;
- system/message source classification;
- compact boundaries;
- tool-use relationships;
- source/native IDs.

Normalized tool calls preserve:

- tool name and category;
- input JSON;
- file path;
- skill name;
- subagent session ID;
- result-event status and metadata.

Sources:

- https://github.com/kenn-io/agentsview/blob/main/internal/parser/provider.go
- https://github.com/kenn-io/agentsview/blob/main/internal/parser/claude_provider.go
- https://github.com/kenn-io/agentsview/blob/main/internal/parser/codex_provider.go
- https://github.com/kenn-io/agentsview/blob/main/internal/ingest/convert.go

This is exactly the machinery Workflow Miner should avoid rebuilding unless a demonstrated information gap requires it.

### SQLite is already a normalized local archive

AgentsView's normal mode imports parsed sessions into a local SQLite archive. The same archive backs its UI, CLI, REST API, search, analytics, and MCP surface.

It also supports:

- filesystem/session watchers;
- incremental sync;
- FTS search;
- optional semantic/hybrid search;
- PostgreSQL for multi-machine/shared read scenarios;
- DuckDB and ClickHouse mirrors;
- additional filesystem roots and machine attribution.

For Workflow Miner, the important point is not the analytics UI. It is that AgentsView can act as a maintained provider-neutral **system of record** between native session formats and our mining layer.

Sources:

- https://www.agentsview.io/
- https://www.agentsview.io/docs/filesystem-sync/
- https://www.agentsview.io/docs/pg-sync/

### Stable Session API is a strong integration seam

AgentsView explicitly describes the `agentsview session` CLI and matching HTTP endpoints as a stable programmatic surface.

Useful operations include:

- `session list` — filter and page normalized session metadata;
- `session get` — session detail and deterministic signal fields;
- `session messages` — bounded/paged normalized message windows;
- `session tool-calls` — chronological normalized tool calls;
- `session search` — search message bodies, tool inputs, and tool-result content.

The message API exposes role/content/timestamp plus source classification. It also promotes useful lifecycle markers such as:

- `continuation`;
- `resume`;
- `interrupted`;
- `task_notification`;
- `stop_hook`;
- `compact_boundary`.

The tool-call API exposes tool name/category, serialized input, skill name, subagent link, timestamp, and result length.

This is already close to the normalized evidence representation Workflow Miner planned to build itself.

Source:

- https://www.agentsview.io/docs/session-api/

### Conversation Export may be an even better incremental seam

AgentsView 0.44.0 adds a normalized conversation-export protocol that is especially relevant to Workflow Miner.

The consumer first reads a **text-free change listing**. That listing identifies changed sessions/messages and their revisions, digests, project evidence, and byte counts without returning message bodies. The consumer can then fetch only the specific current message bodies it actually needs.

Important properties:

- works from the normalized SQLite archive across supported agents;
- does not reparse native transcripts;
- supports incremental checkpoints;
- distinguishes revisions/deletions/gaps;
- can fetch bounded chunks of one selected message body;
- explicitly tells consumers to resolve project-sharing eligibility before fetching message bodies.

This maps extremely well onto Workflow Miner's desired privacy flow:

```text
AgentsView text-free changes/session catalogue
                    ↓
        Workflow Miner scope gate
                    ↓
         allowed sessions/messages
                    ↓
        selective body retrieval
                    ↓
     deterministic evidence reduction
                    ↓
             semantic mining
```

Conversation Export deliberately omits separate thinking text, system/tool-result messages, tool arguments, and tool-result fields. Therefore it is likely the best incremental source for **human/assistant prose**, while the Session API can supplement it when tool-call structure is required.

Source:

- https://www.agentsview.io/docs/conversation-export/

### MCP is useful, but probably not the primary ingestion contract

AgentsView also exposes a read-only MCP server with session listing, message retrieval, content search, and related tools.

That is attractive for interactive agents that need to look up historical evidence. For Workflow Miner's deterministic collection pipeline, however, the versioned CLI/HTTP/session-export surfaces appear more suitable because they provide explicit pagination, revisions, checkpoints, and machine-readable contracts.

MCP may still be useful later as an interactive research or evidence-navigation surface.

Source:

- https://www.agentsview.io/docs/mcp/

### Project/workspace attribution is already a first-class concept

AgentsView does not treat the display project name as the only identity.

It records working directories, performs Git/project attribution, understands worktrees, and supports explicit project-mapping rules. Version 0.44.0 also includes an opt-in Data project workspace with:

- project inventory;
- folder suggestions;
- observed working directories;
- transcript previews;
- bulk project corrections;
- explicit `Folder path → Project` rules;
- per-session manual project overrides.

The richer workspace is currently a build-time opt-in feature, but the underlying project rules and identity machinery exist independently of that UI.

This is useful to Workflow Miner because project attribution is one of the hardest parts of combining work across sessions without treating the repository as the collection boundary.

Sources:

- https://www.agentsview.io/docs/data/
- https://www.agentsview.io/docs/configuration/
- https://www.agentsview.io/docs/session-export/

### AgentsView has a privacy control close to our scope gate, but it is not sufficient by itself

AgentsView supports:

```toml
sync_include_cwd_prefixes = [
  "/home/me/work/client-a",
  "/home/me/oss",
]
```

When this list is non-empty, local ingestion accepts only sessions whose recorded working directory equals or falls underneath an allowed prefix. Sessions without a recorded cwd are skipped while the filter is active.

The implementation is path-boundary aware and applies the gate before storing parsed sessions.

However, its semantics differ from Workflow Miner's required policy:

- an empty AgentsView list means **allow all**, while Workflow Miner requires empty `include` to mean **allow nothing**;
- there is no equivalent documented `exclude` override in this cwd-ingestion setting;
- the option applies to local sync; remote sync is explicitly unaffected;
- sessions already present in an archive are not made safe merely by adding a new ingestion filter;
- some providers may lack reliable cwd attribution, and AgentsView intentionally skips them when the filter is active.

Therefore AgentsView's cwd filter can be useful **defense in depth**, but Workflow Miner must keep its own default-deny scope policy and apply it before fetching detailed message content or exporting evidence.

Sources:

- https://www.agentsview.io/docs/configuration/
- https://github.com/kenn-io/agentsview/blob/main/internal/sync/cwd_filter.go
- https://pkg.go.dev/go.kenn.io/agentsview/internal/config

### Archive-content modes overlap strongly with our planned reducer

AgentsView can retain session content at three levels:

- `full` — transcript plus tool inputs/results;
- `transcripts` — conversation text and useful tool metadata, but no tool inputs/results;
- `usage` — accounting/session metadata without conversation text.

The `transcripts` mode is strikingly close to the first deterministic reduction Workflow Miner originally planned: preserve human/assistant conversation and coarse tool structure while discarding the largest tool payloads.

There is a trade-off:

- `transcripts` is compact and safer, but loses command arguments and error/result text that can occasionally explain repeated friction;
- `full` retains that evidence locally, while Workflow Miner can still choose not to retrieve it unless a candidate requires it.

A good initial experiment is therefore to keep AgentsView as the local archive and make **selective retrieval**, rather than archive retention itself, the Workflow Miner privacy/reduction boundary.

Source:

- https://www.agentsview.io/docs/configuration/#archive-content

### AgentsView already computes useful deterministic friction signals

AgentsView Session Intelligence and Quality compute deterministic signals rather than asking a model to judge every session.

Examples include:

- tool failures;
- repeated identical tool calls/retries;
- edit churn;
- failure streaks;
- compaction counts;
- context pressure;
- session outcome/health summaries.

These signals are useful candidate features for Workflow Miner and may eliminate some low-level preprocessing.

But they are mostly **within-session operational signals**. They are not the same as Workflow Miner's core target:

- repeated human corrections across sessions;
- semantically equivalent steering phrased differently;
- "we already decided this" / "do not ask me this again" behavior;
- repository infrastructure coverage;
- selection of AGENTS vs skill vs script vs config vs docs.

Sources:

- https://www.agentsview.io/docs/session-intelligence/
- https://www.agentsview.io/docs/quality/

### Recall and Generated Insights overlap, but do not replace Workflow Miner

AgentsView also has experimental Recall and model-generated Insights.

Recall can extract durable facts, procedures, preferences, and warnings with links to supporting messages. Generated Insights can produce model-written reports over an explicitly selected session scope.

This overlaps with evidence extraction and semantic summarization, but it does not appear to implement Workflow Miner's intended infrastructure-gap reasoning:

```text
recurring friction
      ↓
scan current repo/user automation surface
      ↓
already covered / partial / conflicting / missing
      ↓
choose smallest durable owner
      ↓
propose concrete artifact change
```

Source:

- https://www.agentsview.io/docs/recall/

### What AgentsView could eliminate from Workflow Miner

If the validation spike confirms fidelity, Workflow Miner probably should **not** own:

- Claude/Codex native transcript discovery;
- provider JSONL parsing;
- provider format migrations;
- session identity/deduplication;
- resumed-session/subagent relationship plumbing;
- file watching and incremental source refresh;
- normalized session/message/tool-call storage;
- local SQLite schema and migrations;
- FTS/search indexing;
- most project/worktree attribution;
- multi-machine archive plumbing;
- basic deterministic session failure/retry signals.

That is a very large reduction in scope and maintenance burden.

### What Workflow Miner would still uniquely own

Workflow Miner would remain responsible for:

1. strict default-deny include/exclude policy at the evidence boundary;
2. selecting only eligible session/message evidence;
3. deterministic compact evidence generation;
4. semantic normalization of repeated human steering and friction across sessions;
5. cross-project/provider/contributor evidence aggregation;
6. scanning the existing automation surface:
   - AGENTS.md;
   - skills;
   - scripts/hooks;
   - configs;
   - docs;
   - existing automations;
7. classifying coverage:
   - already covered;
   - partially covered;
   - conflicting;
   - genuinely missing;
8. choosing the smallest durable destination;
9. producing an actionable evidence-backed automation backlog.

### Provisional architecture

If the spike succeeds:

```text
Claude / Codex / Cursor / other native stores
                    ↓
                AgentsView
        parse / normalize / index / store
                    ↓
   Conversation Export + Session API
                    ↓
        Workflow Miner scope gate
                    ↓
     compact friction evidence layer
                    ↓
 semantic recurring-pattern normalization
                    ↓
      infrastructure coverage scan
                    ↓
      smallest missing durable artifact
```

This would make Workflow Miner an **evidence-to-infrastructure-gap detector**, not another session archive.

### Relationship to AHP

AgentsView and AHP solve overlapping but different problems.

AHP is an attractive live provider-neutral protocol at the VS Code Agent Host boundary. AgentsView is much stronger as a historical archive and already owns provider-specific parsing, normalization, indexing, project attribution, and storage.

Do not choose between them yet.

A reasonable working hypothesis is:

- **AgentsView** for historical ingestion/index/storage;
- **AHP** only if it proves useful for live sessions, Agent Host-only providers, or evidence unavailable from AgentsView.

Avoid maintaining two ingestion paths unless the validation experiments demonstrate a real need.

### Concrete validation spike

Before changing Workflow Miner package architecture:

1. Install/run AgentsView against a machine containing known Claude and Codex history.
2. Compare AgentsView session counts and identities against the native stores and the AHP catalogue.
3. Inspect `agentsview session list --json` for:
   - agent/provider;
   - project;
   - cwd/working directory;
   - timestamps;
   - branch;
   - parent/subagent metadata.
4. Select one Claude and one Codex session containing:
   - explicit human correction/steering;
   - tool failures/retries;
   - compaction or resume;
   - subagent activity if available.
5. Inspect:
   - `agentsview session messages <id> --json`;
   - `agentsview session tool-calls <id> --json`.
6. Compare those normalized records with the native transcript and list anything important that was lost.
7. Exercise Conversation Export:
   - read a text-free change page;
   - apply a local allowlist decision;
   - fetch only one allowed message body;
   - save/reuse a checkpoint.
8. Verify that Workflow Miner can make its allow/deny decision **before** fetching body text.
9. Test an unknown/no-cwd session and confirm it fails closed in the Workflow Miner layer.
10. Measure the amount of normalized evidence retrieved versus raw provider transcript size.
11. Repeat after adding one new message to confirm incremental behavior.

### Decision criterion

Prefer AgentsView as Workflow Miner's primary ingestion/index/storage dependency if:

- Claude and Codex historical coverage is sufficiently complete;
- normalized messages preserve the human steering needed for friction mining;
- tool-call metadata is sufficient or can be selectively supplemented;
- project/cwd metadata is sufficient to enforce Workflow Miner's scope gate before body retrieval;
- incremental Conversation Export or Session API can be consumed without copying the whole archive.

Only build native provider ingestion for a concrete, measured gap that AgentsView and AHP cannot cover.

### Provisional recommendation

**Do not implement the placeholder Claude/Codex providers yet.**

AgentsView is currently the strongest candidate for removing the largest and least differentiated part of Workflow Miner: native ingestion, normalization, indexing, and storage.

The next useful work is not more provider code. It is a small local validation of AgentsView's normalized output and privacy boundary, followed by comparison with AHP and the remaining discovery candidates.

