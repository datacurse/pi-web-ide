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
- Pick by role, not by how much room there is:
  - The main line of any row or tab is `text-ui`: Explorer and Source Control
    files, session list titles, session and terminal tabs, directory-picker
    rows, package names.
  - The line under it, hints, paths, timestamps in a subline, status text:
    `text-meta`.
  - `text-caption` only for badges and tags (`pinned`, `off`, `added`), counts,
    compact right-aligned stamps (`2h`), the version string, code-block
    language labels and uppercase section labels. Never a sentence or a path.
- A button is never below `text-meta`: use `Button size="sm"`.
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

## Spacing and heights

- Spacing uses Tailwind's 4px scale: `0.5 1 1.5 2 3 4 6`. Markdown's `pl-5`
  list indent and em-based prose margins are the only exceptions.
- Arbitrary px spacing or heights (`py-[5px]`, `h-[30px]`) fail the check.

| Token            | Size | Use                                              |
| ---------------- | ---- | ------------------------------------------------ |
| `control-sm`     | 24px | `Button`/`IconButton` `sm`: toolbars, headers.   |
| `control-md`     | 28px | `Button`/`IconButton` `md`: dialogs, composer.   |
| `bar`            | 36px | `PanelHeader`: every panel and editor top row.   |

They are spacing keys, so `h-control-sm`, `size-control-md` and `h-bar` all work.
Text and icon buttons of the same size share a height and line up in a row.

## Color roles

Themes remap `neutral-*`, so components name the neutral step, never a hex.

- Primary text `neutral-100`/`200`; secondary `neutral-300`/`400`; hints `neutral-500`; disabled `neutral-600`.
- Accent and primary action: `amber-*`. Errors: `red-*`. Success: `green-*`.

## Composer

- The `?` button (directly left of Send, so Stop never shifts it) toggles "Ask only": an outline round
  `IconButton` with a 14px `QuestionMark`, matching the attach `+`;
  `aria-pressed`, amber icon when on. It stays on until switched off.

## Tabs

- Session (AI) tabs lead with an amber bold `π` (the greeting-screen mark); file tabs use `FileGlyph`, diff tabs `GitDiff`.

## Primitives (`src/web/ui.tsx`)

New UI uses these; convert raw markup when you touch it. Tune styles in
`ui.tsx`, never at call sites. `className` is for layout only (margin, width, flex).

| Primitive       | Props                                                       | Use |
| --------------- | ----------------------------------------------------------- | --- |
| `Button`        | `variant`: primary / secondary (default) / subtle / ghost / warning (inside amber notices); `size`: sm (12px) / md (13px) | Text buttons. One `primary` per dialog or panel. Cancel is `secondary`. |
| `IconButton`    | `label` (required; aria-label + tooltip), `variant`: ghost / outline / solid, `size`: sm 24px / md 28px, `round` | Icon-only buttons. `round` only in the composer toolbar. |
| `MenuItem`      | button props                                                | Rows in dropdown and context menus. |
| `Section`       | `title`                                                     | Settings group (fieldset + uppercase legend). |
| `OptionRow`     | `selected`, `disabled`                                      | Clickable row wrapping a radio or checkbox. |
| `sectionLabel`  | class string                                                | Uppercase group heading on any element. |
| `inputClass.sm/md` | class string                                             | Inputs and textareas (a string so refs pass through). |
| `ListRow`       | `selected`, `muted`, button props                           | Tree and list rows (Explorer, Source Control, directory picker). 22px; indent with `style.paddingLeft`. |
| `tabClass(active)` | class string; caller adds `pr-7` (with close button) or `pr-2.5` | Session/editor tabs and terminal tabs: 32px, amber top border when active. |
| `PanelHeader`   | `title?`, `onClose?`, `closeLabel?`, children               | Top row of a side panel or editor tab. Children go after the title. |

- Body text defaults to `text-ui`; set a size only when it differs.
- A state color on an icon goes on the icon (`<Star className="text-amber-400">`), not on the button.
- `check-ui.sh` also fails on hand-rolled copies of `Button` primary/subtle,
  `inputClass` and `sectionLabel`. Add a rule there when a new primitive lands.
- Every raw `<button>`, `<input>`, `<textarea>` and `<select>` outside `ui.tsx`
  fails `scripts/check-raw.pl` unless it uses `inputClass`/`tabClass` or carries
  `data-custom="reason"`. Checkbox, radio, file and hidden inputs are exempt.
  `data-custom` is for one-off controls with no primitive yet; when the same
  reason appears 3+ times, extract a primitive.
- Current `data-custom` reasons: `tab close`,
  `composer pill` (model selects, git split button), `composer`, `choice card`
  (chat question options, package search hits), `session card`, `transcript
  disclosure`, `context meter`, `image thumbnail`, `thumbnail remove badge`,
  `pinned-folder chip`, `activity bar item`.
- xterm reads `--text-body` at mount (Terminal.tsx); it cannot take a class.
- Buttons default to `type="button"`; pass `type="submit"` explicitly.

## Open questions

- `ChoiceCard`: two uses (chat questions, package search) — one more and extract.
- Dialog headers (Settings, DirectoryPicker, Packages add) use `text-title`
  and are not `PanelHeader`. Candidate: `Dialog`.
- Candidates once they repeat: `Badge`, segmented tabs (Packages).
