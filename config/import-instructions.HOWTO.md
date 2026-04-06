# How to customize import-instructions.md

`config/import-instructions.md` is the prompt sent to Claude when you run `npm run import -- <path>`. Edit it freely to tailor what gets imported from your source folder.

## Placeholders

These get substituted at run time before the prompt is sent to Claude:

| Placeholder | Replaced with |
|---|---|
| `{{SOURCE}}` | absolute path of the source folder you passed to `npm run import` |
| `{{TARGET}}` | absolute path of `storage/memory/` |
| `{{DATE}}` | today's date in `YYYY-MM-DD` format |

## Common customizations

**Exclude specific folders in your source:**
Add to the "What to IGNORE" section:
```
- Anything under `projects/private/`
- Files matching `*-draft.md`
```

**Skip auto-creating person buckets for certain numbers:**
Add a rule like:
```
Do not create person-* buckets for numbers starting with +1
```

**Force certain buckets to always load:**
Beyond `global-*`, you can mark other buckets with `always_load: true`. Instruct Claude in the "Rules" section.

**Change taxonomy:**
Rename or add scopes (e.g. add `company-<slug>/` for work contexts) and update the "Output structure" section.

**Tighten or loosen the "significant person" threshold:**
Default is "significant collaborators, partners, recurring contacts". Tweak to "mentioned in at least 3 documents" or "appears in project briefs" etc.

## Running

```
npm run import -- /absolute/path/to/source
```

The importer reads your edited `import-instructions.md`, substitutes placeholders, spawns Claude with Read+Write access to both the source and `storage/memory/`. Claude does the work, writes bucket folders, then returns a summary.

## Re-running

Re-running the import on the same source is safe — Claude will update existing buckets rather than duplicate. Use this after:
- Adding new folders/content to your source
- Changing the instructions to be more/less inclusive
- Fixing issues with the previous import

## Troubleshooting

If Claude produces malformed frontmatter or misses required fields, edit the "Rules" section of `import-instructions.md` to be more explicit.

If the import is too slow or expensive, tighten "What to extract" and add more items to "What to IGNORE".
