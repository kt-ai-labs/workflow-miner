# Discovery harnesses

This directory contains short-lived or exploratory code used to validate external integration points before they become Workflow Miner packages.

## AHP session catalogue

`ahp-sessions.ts` connects to the local VS Code Agent Host endpoint, calls AHP `listSessions`, and prints the lightweight session catalogue.

It intentionally **does not load chat transcripts**. The first question is whether AHP already exposes enough provider/project/working-directory metadata to perform Workflow Miner's privacy gate before any detailed session content is loaded.

Install dependencies once:

```bash
npm install
```

Run:

```bash
npm run discovery:ahp
```

Useful filters:

```bash
npm run discovery:ahp -- --provider claude
npm run discovery:ahp -- --provider codex
npm run discovery:ahp -- --include ~/Git/Personal
npm run discovery:ahp -- --include ~/Git/Personal --exclude ~/Git/Personal/private
npm run discovery:ahp -- --project workflow-miner --sort project
npm run discovery:ahp -- --json
```

For VS Code Insiders:

```bash
npm run discovery:ahp -- --product-name "Code - Insiders"
```

Or pass the exact user-data directory:

```bash
npm run discovery:ahp -- --user-data-dir /path/to/user-data
```

The script reads only local Agent Host endpoint metadata and AHP session summaries. It does not write evidence or export data.

### Why the dependencies are at the repository root

This is discovery code, not a publishable Workflow Miner package. The root workspace owns its tooling dependencies until the spike proves that AHP should become a real provider package.
