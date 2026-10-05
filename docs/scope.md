# Collection scope

Workflow Miner uses a **default-deny** collection policy.

## Rules

1. Nothing is collected unless it matches an explicit `include` rule.
2. Matching an `include` rule allows the path.
3. A matching `exclude` rule overrides `include` and denies the path.
4. An empty `include` list means collect nothing.
5. Collecting everything must be explicitly requested with a broad include pattern such as `~/**`.
6. Scope filtering happens **before** evidence extraction. Sessions outside the allowed scope must not produce shared evidence.

Example:

```yaml
scope:
  include:
    - ~/Git/Personal/**
    - ~/Downloads/**
  exclude:
    - ~/Downloads/private-temp/**
```

This makes accidental over-collection fail closed: configuration mistakes should omit data rather than include unintended work.
