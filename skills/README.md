# Skills

A **Skill** is a named set of instructions the Assistant follows for one kind of Request. The musician uses one by starting a Request with its slash command, such as `/fix-clipping` or `/drum-beat 124 bpm house`, and browses them with **View skills** in the Assistant Widget.

Each Skill is a folder here holding one `SKILL.md`:

```markdown
---
name: fix-clipping
title: Fix clipping
category: Mixing
description: One sentence the skills list shows.
argument-hint: what may follow the command, such as "[a Track to focus on]"
---

The instructions, written to the Assistant, in `CONTEXT.md`'s terms.
```

- `name` is the slash command, and must be the folder's name: lower case letters, digits and hyphens.
- `title` and `description` are what **View skills** shows; `argument-hint` is optional.
- `category` is one of Songwriting, Drums, Arrangement, Mixing, Mastering or Genres (`SKILL_CATEGORIES` in `app/src/assistant/skills.ts`), and **View skills** can show one category at a time. A new category is added there first.
- The body is sent to the model with the Request, followed by whatever the musician typed after the command. Name tools as the system prompt does (`app/src/assistant/context.ts`), and keep to what the Assistant can do.

The app bundles every folder here at build time (`app/src/assistant/skills.ts`), and a test checks each one parses. A new Skill needs no code: add its folder.
