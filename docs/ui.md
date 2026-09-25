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

## Primitives (`src/web/ui.tsx`)

New UI uses these; convert raw markup when you touch it. Tune styles in
`ui.tsx`, never at call sites. `className` is for layout only (margin, width, flex).

| Primitive       | Props                                                       | Use |
| --------------- | ----------------------------------------------------------- | --- |
| `Button`        | `variant`: primary / secondary (default) / subtle / ghost; `size`: sm (12px) / md (13px) | Text buttons. One `primary` per dialog or panel. Cancel is `secondary`. |
| `IconButton`    | `label` (required; aria-label + tooltip), `variant`: ghost / outline / solid, `size`: sm 24px / md 28px, `round` | Icon-only buttons. `round` only in the composer toolbar. |
| `MenuItem`      | button props                                                | Rows in dropdown and context menus. |
| `Section`       | `title`                                                     | Settings group (fieldset + uppercase legend). |
| `OptionRow`     | `selected`, `disabled`                                      | Clickable row wrapping a radio or checkbox. |
| `sectionLabel`  | class string                                                | Uppercase group heading on any element. |
| `inputClass.sm/md` | class string                                             | Inputs and textareas (a string so refs pass through). |

- Body text defaults to `text-ui`; set a size only when it differs.
- A state color on an icon goes on the icon (`<Star className="text-amber-400">`), not on the button.
- `check-ui.sh` also fails on hand-rolled copies of `Button` primary/subtle,
  `inputClass` and `sectionLabel`. Add a rule there when a new primitive lands.
- xterm reads `--text-body` at mount (Terminal.tsx); it cannot take a class.
- Buttons default to `type="button"`; pass `type="submit"` explicitly.

## Open questions

- Not yet converted: Review/DiffView toolbar actions (duplicated between the
  two files), Terminal tab strip, DirectoryPicker breadcrumbs,
  SourceControl group headers, Packages tab buttons.
- Candidates once they repeat: `PanelHeader`, `Badge`, `Dialog`.
