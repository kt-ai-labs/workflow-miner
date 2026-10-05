# Discovery harnesses

This directory contains short-lived or exploratory code used to validate external integration points before they become Workflow Miner packages.

## AHP session catalogue

`ahp-sessions.ts` connects to the local VS Code Agent Host endpoint, calls AHP `listSessions`, and prints the lightweight session catalogue.

It intentionally **does not load chat transcripts**. The first question is whether AHP already exposes enough provider/project/working-directory metadata to perform Workflow Miner's privacy gate before any detailed session content is loaded.

## Setup

Install dependencies once from the repository root:

```bash
npm install
```

## Quick commands

Show all discovered sessions:

```bash
npm run discovery:ahp
```

Filter by provider:

```bash
npm run discovery:ahp -- --provider claude
npm run discovery:ahp -- --provider codex
```

Filter by directory:

```bash
npm run discovery:ahp -- --include ~/Git/Personal
npm run discovery:ahp -- --include ~/Git/Personal --exclude ~/Git/Personal/private
```

Filter by project and sort:

```bash
npm run discovery:ahp -- --project workflow-miner
npm run discovery:ahp -- --project workflow-miner --sort project
npm run discovery:ahp -- --sort modified
npm run discovery:ahp -- --sort created
npm run discovery:ahp -- --sort provider
npm run discovery:ahp -- --sort title
```

Machine-readable output:

```bash
npm run discovery:ahp -- --json
```

VS Code Insiders:

```bash
npm run discovery:ahp -- --product-name "Code - Insiders"
```

Use an explicit VS Code user-data directory:

```bash
npm run discovery:ahp -- --user-data-dir /path/to/user-data
```

Show the built-in help:

```bash
npm run discovery:ahp -- --help
```

## What the harness reads

The script reads only:

- local VS Code Agent Host endpoint metadata;
- AHP session summaries returned by `listSessions`.

It currently does **not** load chat transcripts, write evidence, or export session content.

## Why the dependencies are at the repository root

This is discovery code, not a publishable Workflow Miner package. The root workspace owns its tooling dependencies until the spike proves that AHP should become a real provider package.
