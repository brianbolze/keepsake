# Vocabulary and naming rules

Read by agents and by `consolidate.ts`. In every section except Rules, a line is a comma-separated tag list;
lines starting with `>` are notes. Add a tag by adding it to a list.

## Rules

> Lowercase, 1-3 words, singular. Proper nouns and acronyms keep their normal case (Figma, iOS, CSS, Claude Code).
> Reuse exact spellings from this file. Coin a new tag only when nothing fits (GUIDE.md says how).
> Tool tags use the exact product name, and only when the tool is visible or stated. Don't add generic duplicates ("AI agent", "AI tool"); Jev's topic "AI and agents" covers the area.
> Don't tag authors or dates. Don't add "video" or "image".
> Never add the group names (overlays, data display, activity states, navigation, inputs, motion, AI interface). They are added automatically from the pattern tags. "onboarding" and "layout" are also tags you may use directly.
> Use the most specific pattern: `context menu` or `dropdown menu`, not also `menu` (`menu` is a navigation menu). A Cmd-K launcher is `command palette`, not `popover`.
> Jev's inferred topics (kept automatically, don't repeat): interface design, animation, typography, design systems, React, SwiftUI, developer tools, AI and agents, databases, open source, product thinking, web performance.

## UI patterns

> The most important facet. Tag every pattern clearly visible. Format: `- group: patterns`.

- overlays: modal, popover, tooltip, drawer, side panel, dropdown menu, context menu, command palette, toast, sheet, lightbox
- data display: table, chart, dashboard, data viz, stat card, list view, card, timeline, calendar, map, badge, chip, avatar, code block, accordion
- activity states: loading state, skeleton, progress bar, empty state, error state, success state, status indicator, streaming, notification
- onboarding: onboarding, signup screen, login screen, welcome screen, product tour, checklist, permission prompt
- navigation: sidebar, tab bar, navbar, breadcrumb, pagination, menu, stepper
- inputs: form, text input, select, date picker, slider, toggle, segmented control, button, file upload, search, filter, autocomplete
- layout: landing page, pricing page, settings, hero, bento grid, split view, footer, layout
- motion: micro-interaction, hover effect, scroll effect, page transition, text animation, drag and drop, cursor effect, logo animation
- AI interface: chat interface, agent UI, prompt input, tool-call display, approval flow, canvas, generative UI

## Format

> What the save is. `screen recording` is only for captured screens; real-world camera video is `footage`.

screen recording, screenshot, footage, diagram, code snippet, carousel, article, thread, tutorial, talk, interview, meme, announcement, opinion, prompt, illustration, photo, infographic, product launch video, motion graphics, cheatsheet, resource list, before and after

## Subject

component library, UI component, icon set, design token, design spec, design tip, design process, design tool, color palette, typography specimen, gradient, texture, background, 3D, shader, generative art, portfolio, branding, accessibility, performance, asset pack
agent workflow, agent skill, agent memory, prompt engineering, system prompt, model release, model comparison, benchmark, workflow automation, CLI, MCP, plugin, RAG, testing, codebase visualization, product launch, pricing, funding, startup advice, hardware, fintech

## Platform

mobile app, desktop app, web app, iOS, macOS

## Tool

Claude, Claude Code, Claude Design, Claude Cowork, Codex, ChatGPT, Cursor, Jev, TypeSafe, Fable, Figma, Framer, Stitch, Notion, Linear, Vercel, GitHub repo, Next.js, React, Tailwind, shadcn/ui, Untitled UI, Three.js, Framer Motion, GSAP, Lucide, CSS, SVG, Swift, Blender, Firecrawl, AGENTS.md, DESIGN.md, markdown

## Style

> Only when distinctive. Add light mode or dark mode only when the theme is the point.

dark mode, light mode, glassmorphism, minimal, editorial, retro, brutalist, skeuomorphic, neon, pixel art, engraving style

## Not design or dev

> Viral clips, sports, personal, politics, health. Use `off-topic` plus at most one format tag and a one-sentence description. Don't force design tags.
> Opinions and news about AI labs, models or dev tools are not off-topic: tag them `opinion` or `announcement` plus the subject.

off-topic
