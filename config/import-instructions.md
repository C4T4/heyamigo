You are importing an external knowledge folder into this bot's long-term memory.

Source folder: `{{SOURCE}}`
Target memory folder: `{{TARGET}}`
Today: {{DATE}}

## What to extract

Durable knowledge only:
- People who appear as significant collaborators, partners, or recurring contacts
- Active projects with their purpose, team, status
- Topics with recurring relevance
- Global context: identity, values, priorities, permissions

## What to IGNORE

- Raw conversation logs, daily journal files, status dumps
- Transient state files, cron queues, session files
- Secrets, credentials, auth tokens, .env files
- One-off mentions, contacts with a single mention
- Anything in paths matching: `.git/`, `node_modules/`, `storage/`, `auth/`, `*.log`

## Output structure

Organize into folder-buckets under `{{TARGET}}/buckets/<slug>/`:
- `global-identity/`
- `global-permissions/`
- `global-priorities/`
- `person-<slug>/` for significant people only
- `project-<slug>/` per active project
- `topic-<slug>/` for cross-cutting themes

## Each bucket MUST have an index.md with YAML frontmatter

```yaml
---
title: Human-readable title
scope: global | person | project | topic
tags: ["tag1", "tag2"]
linked_numbers: ["4917..."]
linked_jids: ["120363..."]
always_load: true
updated_at: YYYY-MM-DD
---

# Title

One-paragraph summary.

## Files
- brief.md — <description>
- <other>.md — <description>
```

## Rules

- Set `always_load: true` for `global-*` buckets only.
- Create 1 to 4 focused topical markdown files per bucket. Each file under 500 tokens.
- Distill, do not copy raw content verbatim.
- Do not invent facts not present in the source.
- Every bucket must have a valid index.md with frontmatter.
- After creating buckets, update `{{TARGET}}/buckets/index.md` to list them.
- Update `{{TARGET}}/index.md` if structural changes warrant it.

## When done

Respond with a short summary: bucket slugs created, file counts, anything notable skipped. Do not dump file contents.
