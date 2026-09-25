# UI rules

Tokens live in `src/web/index.css` (`@theme`). Tailwind's default type and radius
scales are deleted, so only the classes below generate CSS. `pnpm typecheck`
runs `scripts/check-ui.sh`, which fails on anything off-scale.

Change a value in `@theme`, not in components. Add a token only when a real use
fits none of the existing ones, and record it here.

## Type

| Class               | Size   | Use                                              |
| ------------------- | ------ | ------------------------------------------------ |
| `text-caption`      | 11px   | Floor. Badges, counts, uppercase section labels. |
| `text-meta`         | 12px   | Hints, secondary labels, mono chips.            |
| `text-ui`           | 13px   | Default chrome: buttons, list rows, inputs, menus, panel headers. |
| `text-body`         | 14px   | Content: chat tool output, notices, questions, editors, tables. |
| `text-title`        | 16px   | Dialog titles, empty-state heading.              |
| `text-display`      | 48px   | The π mark only.                                 |
| `.chat-prose`       | 17px   | Assistant/user prose (`--prose-size`).           |
| `text-h1/h2/h3`     | em     | Markdown headings, relative to prose.            |
| `text-code-inline`  | 0.875em | Inline code and math fallback inside prose.     |

- Never go below 11px.
- Hierarchy comes from color and weight first, size second. Section labels are
  `text-caption uppercase tracking-wide text-neutral-500`.
- Arbitrary sizes (`text-[13px]`) are banned.

## Radius

| Class          | Size | Use                                            |
| -------------- | ---- | ---------------------------------------------- |
| `rounded-sm`   | 4px  | Controls: buttons, inputs, chips, inline code, list-row hovers. |
| `rounded-md`   | 8px  | Floating surfaces: menus, popovers, dialogs, thumbnails. |
| `rounded-lg`   | 12px | The composer and the user message bubble.      |
| `rounded-full` | —    | Composer toolbar pills and icon buttons, dots, badges, progress bars. |

- Side variants use the same scale: `rounded-t-sm`.
- Dialog and form buttons are `rounded-sm`, not pills.

## Color roles

Themes remap `neutral-*`, so components name the neutral step, never a hex.

- Primary text `neutral-100`/`200`; secondary `neutral-300`/`400`; hints `neutral-500`; disabled `neutral-600`.
- Accent and primary action: `amber-*`. Errors: `red-*`. Success: `green-*`.

## Tabs

- Session (AI) tabs lead with an amber bold `π` (the greeting-screen mark); file tabs use `FileGlyph`, diff tabs `GitDiff`.

## Open questions

- Control heights (target 24/28/32px) are not tokenized yet.
- Shared primitives (`Button`, `IconButton`, `Badge`, `Input`, `SectionLabel`,
  `PanelHeader`, `MenuItem`) do not exist yet. Extract one when a pattern
  repeats 3+ times; put them in `src/web/ui/`.
