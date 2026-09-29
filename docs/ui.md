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
| `.chat-prose`       | 17px   | Assistant/user prose (`--prose-size`), and reasoning. |
| `.chat-code`        | 15px   | Code blocks, tool/group/thought lines (`--code-size`, the optical match for 17px sans). |
| `text-h1/h2/h3`     | em     | Markdown headings, relative to prose.            |
| `text-code-inline`  | 0.875em | Inline code and math fallback inside prose.     |

- Never go below 11px.
- Pick by role, not by how much room there is:
  - The main line of any row or tab is `text-ui`: Source Control
    files, session list titles, session and terminal tabs, directory-picker
    rows, package names. Exception: Explorer rows are `text-body`
    (`ListRow size="body"`) with 14px folder chevrons.
  - The line under it, hints, paths, timestamps in a subline, status text:
    `text-meta`.
  - `text-caption` only for badges and tags (`pinned`, `off`, `added`), counts,
    compact right-aligned stamps (`2h`), the version string, code-block
    language labels and uppercase section labels. Never a sentence or a path.
- A button is never below `text-meta`: use `Button size="sm"`.
- Hierarchy comes from color and weight first, size second. Section labels are
  `text-caption uppercase tracking-wide text-neutral-500`.
- Arbitrary sizes (`text-[13px]`) are banned.
- An answer reads as one size: prose and reasoning 17px, its mono lines 15px.
  Reasoning and tool lines recede by color and italics, not by size.

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
- An answer has one vertical gap: every block (paragraph, list, code, table,
  reasoning paragraph, tool/group/thought line) is `my-3` and margins collapse.
  Markdown renders without a wrapper div so its blocks are siblings of the tool
  lines. `.flow-trim-start` / `-end` / `.flow-trim` (index.css) drop the gap under
  the speaker label, above the answer footer and inside an opened group.

## Overflowing text

- Cut-off text fades out over its end (`.fade-end`), never `…`. `truncate`,
  `text-ellipsis` and `line-clamp-*` fail the check (except `<select>`/inputs,
  where a mask cannot follow the text). Multi-line: `.fade-clamp` (3 lines).
- Tool call lines are always one line; the result preview fades.

| Token            | Size | Use                                              |
| ---------------- | ---- | ------------------------------------------------ |
| `control-sm`     | 24px | `Button`/`IconButton` `sm`: toolbars, headers.   |
| `control-md`     | 28px | `Button`/`IconButton` `md`: dialogs, composer.   |
| `bar`            | 36px | `PanelHeader`: every panel and editor top row.   |

They are spacing keys, so `h-control-sm`, `size-control-md` and `h-bar` all work.

- Scrollbars (index.css): Chromium gets a hand-drawn 8px `neutral-700` thumb, `rounded-sm`,
  flush against the pane edge, no arrows. Firefox keeps `scrollbar-width: thin`.
  Settings > Appearance > `Hide scrollbars` (`pwi:hideScrollbars`, per browser, off by
  default) hides them all via `data-scrollbars="hidden"` on `<html>`.
Text and icon buttons of the same size share a height and line up in a row.

## Icons

- Phosphor weights `regular`, `bold` and `fill` only. The build strips
  `thin`, `light` and `duotone` (`vite.config.ts`), so those render nothing.

## Color roles

Themes remap `neutral-*`, so components name the neutral step, never a hex.

- Primary text `neutral-100`/`200`; secondary `neutral-300`/`400`; hints `neutral-500`; disabled `neutral-600`.
- Accent and primary action: `amber-*`. Errors: `red-*`. Success: `green-*`.
- Every separator (panel edges, list row rules, table rows) is `border-neutral-800`; no fainter `neutral-900` rules.
- Settings lists themes in two groups, Dark then Light (`light` flag in `prefs.ts`).

## Composer

- Only Send is a filled disc (`solid`); it greys out while there is nothing to send.
  Attach (`Paperclip`), `?` and Stop are `outline` round `IconButton`s; the star is `ghost`.
- The `?` button (directly left of Send, so Stop never shifts it) toggles "Ask only":
  a 14px `QuestionMark`, `aria-pressed`. When on it uses the `on` variant (amber disc, dark
  bold icon) so the state reads at a glance. Right-click it (or Settings > Sessions >
  `Ask only button`, `pwi:askMode`) to pick `Toggle` (default: stays on until switched
  off) or `One shot` (switches off after each send). The menu marks the current mode
  with a `Check`.
- Defaults are starred inside the popups, not in the box: every model and reasoning
  option starts with a star that saves or clears it as pi's startup default
  (`defaultProvider`/`defaultModel`, `defaultThinkingLevel`) without picking it.
  Filled amber for the default, `neutral-600` outline otherwise.
- One model select, providers as `<optgroup>`s, plus the thinking select. Pills are
  sans `text-meta` with `field-sizing-content` so each fits its current option.
  Their popup is styled like a menu via `.pill-select` (index.css, customizable
  `<select>`, Chromium 135+): `rounded-md` neutral-900 surface, `text-ui` rows,
  provider labels as uppercase captions, current option in amber. Other browsers
  show the native popup.
- The context meter sits in the composer's right group, before Stop. Git stays in
  the row above the box.
- That row (jump-to-latest and git) floats over the transcript's bottom edge with no
  band or background of its own; the transcript scrolls under it (`pb-12` keeps its
  last line clear). No gap between the transcript and the box: the transcript fades from 8px
  (the buttons' gap to the box) above the top of the git buttons to fully transparent at the box's top edge (`.fade-bottom`), along
  an ease-out curve, opacity `(1 - t)^3`: it dims hard at the start and settles gently
  into the box. Tried and rejected: linear / CIE L*-even (felt like it darkened faster
  and faster) and Larsen's scrim (worse still).
- The box overlaps the transcript by its radius (`-mt-3`), so text shows behind its
  corners, and sticks out of the reading column by its padding (`-mx-3`), so the typed
  text lines up with the response text, like Cursor. To keep that exact, the transcript
  reserves its scrollbar on both sides (`scrollbar-gutter: stable both-edges`) and the
  box's edge is an inset `ring-1`, not a border. The git row's right edge follows the box,
  `mb-2` above it (the same gap as between its buttons), every button `control-md` tall. It is a 16px ring in a ghost round `IconButton`
  (`neutral-700` track, `neutral-400` fill, amber from 75%, red from 90%), drawn empty
  before the first turn instead of hidden.
- Clicking the ring opens `ContextPanel` above the box (`rounded-md`, like Cursor's):
  - Header: a 56px ring with the % inside, `~used` in `text-title` over `/ window tokens`,
    then a `text-meta` line with what is free and the largest single piece.
  - A full-width `h-2` stacked bar of what the USED part is made of (not scaled to the
    window, so small parts still show).
  - One `ListRow` per part: caret, `size-3` swatch, label, piece count, % of used, tokens.
    Colors: System prompt `neutral-400`, Tool definitions `--ct-mauve`, Rules `green-400`,
    Skills `yellow-500`, Personality `blue-400`, Conversation `--ct-teal`. Empty parts hide.
  - A row opens into its pieces (each tool, rule file, skill; the conversation as your
    messages, replies, thinking, and each tool's calls plus results), `text-meta`, with
    a `w-16` share bar. The largest part starts open.
  - A tool opens further, with a caret left of its name: bash by program (`git status`,
    `grep`, see `shared/toolCalls.ts`), read/edit/write by file, `pl-16`, each bar a share
    of its tool. Expand all opens these too. A bash call the tool-metrics collector split
    into commands counts under each command's program, by its text and the output of it
    the model was shown; other calls count under their first program.
  - Footer: an estimates note and `Compact` (`Button sm`). ✕, Escape or a click
    outside closes it.
  - Beside ✕, an `IconButton sm` expands or collapses every part
    (`ArrowsOutLineVertical` / `ArrowsInLineVertical`).
  - The panel floats over the transcript (absolute, above the box) and grows with its
    content up to the top of the chat, then scrolls; it never moves the layout.
- Clicking an image thumbnail (staged or sent) expands it, centered in the area spanning
  the whole window width (explorer, columns, sessions list) from the top down to just
  above the line you type on. No backdrop: a `border-2 border-neutral-200` `rounded-md`
  frame with `shadow-2xl`, and a round ✕ badge at its top right that shows on hover.
  The composer and the rest of the app stay usable around it. A click on the image or
  Escape closes it.
- Placeholder is `Message pi…`; key hints live in the textarea's `title`. The field
  uses `field-sizing-content max-h-60` and grows as you type.

## Tabs

- Session (AI) tabs lead with a bold `π` (the greeting-screen mark) that is also the live signal (see Attention). File tabs use `FileGlyph`, diff tabs `GitDiff`.
- A tab's close ✕ shows only while the pointer is over that tab (or it has keyboard
  focus), active tab included. Touchscreens always show it (`.tab-close` in index.css).
  It floats over the label's end (no reserved padding, a short fade behind it), so
  labels use the full tab width.
- Tabs are split by a `neutral-800` rule on each tab's right edge.
- A cut-off tab label fades out over its last 2em (`.fade-end`, see Overflowing text).
- Right-click any tab → `ContextMenu`, groups split by `MenuSeparator`:
  1. Session tabs: `Pin Tab` / `Unpin Tab` (the session list's pins), `Rename…`
     (`window.prompt`). File tabs: `Reveal in Explorer` (opens the Explorer, expands
     down to the file, scrolls to and focuses its row), `Copy Path`. Diff tabs: none.
  2. `Close`, `Close Others`, `Close to the Right` (within that column's strip).
- In a split, only the focused column (the one last clicked or focused) keeps the amber
  underline; the other column's active tab drops to `neutral-600` (`tabClass(active, focused)`).

## Attention

Every session has one state, shown the same way everywhere (`ATTENTION_UI` in `attention.ts`):

| State   | Meaning                                  | Tab `π`            | Dot (tab end, list row) |
| ------- | ---------------------------------------- | ------------------ | ----------------------- |
| idle    | nothing new                              | `neutral-500`      | none                    |
| working | streaming                                | amber, pulsing     | list only, pulsing amber |
| ready   | new activity since this browser saw it   | `neutral-500`      | amber                   |
| needs   | blocked on a question (`ask`)            | `red-400`, steady  | red                     |

- An amber `π` only ever means working: a finished turn must not look like one still running.
- "Seen" means on screen in either column while the window is visible and focused.
  Per-browser (`localStorage`), synced across pwi windows.
- Window title: `N ● pwi` — N = ready + needs (omitted at 0), `●` while anything works. No brackets.
- Favicon: the `π` breathes while anything works; a corner dot (red for needs, else amber)
  while anything waits.
- The session list sorts needs, then ready, right after pinned rows.
- Alt+J jumps to the next waiting session: needs first, then the longest-waiting reply.

## Session list

- Right-click a row → `Pin to top` / `Unpin`. Pinned rows sort first (in either sort mode)
  and lead with a 12px filled amber `PushPin`. Pins are per-browser (`localStorage`).
- The same pins apply to the tab strips: a pinned session's tab moves to the front of
  its column and shows the same `PushPin` before the `π`.

## Session search

- Two surfaces, one search (`useSessionSearch` in `searchHits.tsx`):
  - The session list's search field (`inputClass.sm`, under `New session`) filters the
    list in place, in relevance order; each hit's subline shows the matched excerpt
    instead of the date. The count label reads `Searching…` / `N matches`. Escape clears.
  - The `ArrowsOut` `IconButton` beside it, or Ctrl+O from anywhere (captured before
    the terminal and editors), opens the modal popup (`SessionSearch`).
- While a query is in flight the previous results stay on screen (no empty flash).
- Popup: top-anchored `<dialog>`, `rounded-md`, backdrop `bg-black/50` + `backdrop-blur-sm`.
  It is a large centered surface, so it sits one type step above the side-panel rows:
  query `text-title`, row title `text-body`, excerpt and `timeAgo` stamp `text-ui neutral-500`,
  18px icons.
  Matches are bold `neutral-100`. Arrows move, Enter opens, Escape or backdrop closes.
- Empty query lists the most recently active sessions, so it is also a switcher.
- Scope is the open project. Matches user and assistant text and tool-call arguments;
  title matches rank first, then content, then fuzzy (subsequence) title matches.

## Command palette

- Ctrl+P from anywhere (captured like Ctrl+O, over the browser's Print) opens
  `CommandPalette`: the same popup shell as session search, a `Command` icon, rows
  `text-body` with the key binding right-aligned `text-ui neutral-500`.
- Commands are listed in `App.tsx` (`paletteCommands`). Toggles name what they will
  do (`Show Terminal` / `Hide Terminal`). Filtering uses Settings' `matches` (words,
  then fuzzy subsequence). Arrows move, Enter runs, Escape or backdrop closes.

## User message bubble

- Text is clamped to 3 lines (`.fade-clamp`, the last line fades). When it overflows, a ghost
  `Button size="sm"` below it toggles `Show more` / `Show less` with a 12px caret.
  Settings → Transcript → `Your messages` picks Collapsed (default), Expanded (starts
  open, `Show less` still shown) or Always full (no clamp, no button); `pwi:userMessages`.
- On hover, a right-aligned `PencilSimple` ghost `IconButton size="sm"` (`Edit`) sits
  under the pill; hidden while a turn runs. It swaps the pill for a textarea in the same
  `rounded-lg` card (plus a `neutral-700` border) with `Cancel` / primary `Send`
  (`Button sm`). Enter sends, Escape cancels. Sending rewinds the session in place to
  before that message (pi's `/tree`; the old branch stays in the file) and asks again,
  attachments unchanged.

## Reasoning

- Settings → Transcript → `Reasoning`: Shown (default, italic `neutral-500` text), Folded
  or Hidden (`pwi:showThinking`: `1` / `fold` / `0`).
- Folded is `Thought`: a disclosure line like a tool call (11px caret, mono `chat-code`
  `neutral-500`), `Thinking` while the model is still thinking and open, then `Thought`
  and folded once text or a tool call starts. The text sits under a `border-l` like a group.
- In the Grouped and Answer only tool modes reasoning folds into the group either way.

## Answer footer

- Under the message that ends a turn (an assistant message with no tool calls),
  never under intermediate steps: `Copy` and `GitFork` ghost `IconButton size="sm"`
  with 14px icons, then `timeAgo` of when it finished (exact time in `title`) and
  `· 1m 15s`, question to answer. `text-meta neutral-500`, in `chat-measure`.
- Copy swaps to `Check` for 1.2s. Fork is disabled with the label `Forking…` while
  the new session spawns, then opens it as a tab in the same column.

## Explorer

- The header has a refresh `IconButton` (`ArrowClockwise`, `sm`) left of the close ✕.
  It re-reads the root and every expanded folder. The tree also re-reads each time
  the agent finishes a reply.
- Right-click a row → `ContextMenu`, groups split by `MenuSeparator`:
  1. Files: `Open`, `Open to the Side`, and `Open Changes` only when git reports
     the file changed. Folders: `New File…`, `New Folder…`.
  2. `Add to Chat` (appends the project-relative path to the open session's
     composer, disabled with no session), `Open in Terminal` (a new terminal tab in
     the folder, or the file's folder), `Download` (files only).
  3. `Copy Path`, `Copy Relative Path`.
  4. `Cut`, `Copy`, `Paste` (into the folder, or the file's folder; a cut is used
     up by one paste, a copy of a taken name becomes `name copy.ext`).
  5. `Rename…`, `Delete`.
  Everything that changes files (4 and 5) sits together at the bottom, with
  `Delete` last; path copying is read-only and stays above it.
- Right-click the empty space below the rows → the same menu for the project root,
  without the entries that would change or name the root itself.
- New File/Folder and Rename type into an inline field in the row's place:
  Enter or leaving it commits, Escape cancels. Rename selects the name without
  its extension.
- Delete asks with `window.confirm` and moves to the desktop Trash
  (`~/.local/share/Trash`), so it can be restored. Rename, move and delete are
  refused while a file under the path has unsaved edits; open tabs follow a
  rename and close on delete.

## Source Control

- The commit message box is full width. Under it, one row: the `Sparkle` auto-name
  `IconButton` left, the `Auto-name commits` checkbox right. Then `Commit & Push`.
- When the project folder is not a git repository, a checkbox (same style as
  `Auto-name commits`) reads `Find repositories one folder down` (`pwi:gitNested`,
  per browser, off by default). On, a `Repositories` section under the header lists
  each child folder with a `.git`: `FolderSimple` 13px, name, branch in dim mono,
  uncommitted count as a `text-caption` right. The selected row shows the usual
  panel below; the checkbox sits under the list. The rail badge sums all repos.

## Rail, panels, pages and the terminal dock

- The left side panel holds only what you work beside: Explorer and Source Control.
  Clicking the lit icon closes it.
- The terminal is a dock under BOTH editor columns (the shells belong to the project,
  not a column). The rail's terminal button, set apart from the panels by a full-width `neutral-800` rule, and
  Ctrl+` toggle it; its height is a resizable share of the editor area.
- The dock's tabs are a vertical list in a `w-12` side column (`tabClassVertical`), with `+`
  under them and split, split direction, swap side (`ArrowsLeftRight`) and hide stacked
  below. The column sits on the right by default; swap moves it to the left
  (`pwi:termTabsSide`, per browser).
- The dock lists every shell of the project. An editor tab (`term:<id>`,
  `TerminalWindow` icon, label "Terminal") is only another view of one of them:
  a dock tab's right-click "Open in Editor Tab" or the dock's `AppWindow` button opens
  the focused shell in the last-used column, and "New Terminal Tab" in a column also
  lists the new shell in the dock. Closing the editor tab only closes that view (its
  menu is Close items only). Only the dock's per-shell close ends a shell, and that
  closes its editor tabs too. The PTY has one size: whichever view last took focus sets it.
- Right-clicking the transcript (or an empty column) opens `New AI Session` / `New Terminal
  Tab`, both in that column. Not over buttons or the composer area (the box, git row and
  jump-to-latest, `data-no-column-menu`). The browser keeps its own menu over selected
  text, links, images, the composer, and on Shift+right-click.
- Fleet, Stats, Packages and Settings are pages, not tabs (tabs are for work: chats, files,
  terminals). The rail's bottom group opens each in one large centered modal
  (`PageDialog`): `<dialog>`, `h-[85vh] w-[min(64rem,94vw)]`, `rounded-md`, backdrop
  `bg-black/50` + `backdrop-blur-sm`. Escape, the header ✕ or the backdrop closes it.
  A page stays mounted once opened, so unsaved edits survive closing. The rail buttons
  have no lit state. Escape in a popup inside a page (Packages add) closes only that popup.
- Packages has three tabs: `pi packages` (the table; installed into pi, also in a terminal),
  `pwi extensions` (built into pwi and loaded only into the sessions it starts) and `Search`.
  A package with settings (only SoL-Pi, `SolPiSettings.tsx`) gets a `settings` `Button sm`
  (`subtle` while open) after its kind; it opens a row under it: an amber notice when the
  project's `.pi/sol-pi.json` overrides, one `OptionRow` checkbox per mechanism (saved on
  click to `~/.pi/agent/sol-pi.json`), and the file path as status under them. A
  mechanism's own settings sit under its checkbox, lined up with its text, only while it
  is on: the reducer model as one `<select>` of pi's models grouped by provider, saved on
  pick (first option `Built-in: …`, or a disabled `Not selected` when pi cannot reach the
  built-in model; no warning), and the compact's cost ratio as a `w-24` input with `Save`. Tool metrics is an `OptionRow` checkbox (on by default) with
  a `text-meta` line saying what it does. Under it, Personality (`Personality.tsx`, moved
  from Settings): a `text-ui` heading, the file's path, a mono `textarea` with `Save`
  (`Button sm subtle`) and a status line, then the `Repeat before every reply` checkbox.
  It is re-read each time the page is shown unless there are unsaved edits, and the
  pwi extensions tab stays mounted (hidden) on the other tabs so an unsaved edit survives. Changes
  apply to sessions started afterwards. pwi's own plumbing (rewind, context) is not listed.
- Settings has a `w-48` category nav on the left (`NavItem`s: Appearance, Transcript,
  Sessions, Notifications), like Obsidian; the right side shows only the
  chosen category, `max-w-xl p-6`. Opens on Appearance.
- Appearance has a `Language` radio group (English / Русский, each named in itself,
  `pwi:language`, per browser). Every interface string goes through `t("English text")`
  or `plural(n, one, other)` from `i18n.ts`; the Russian lives in `i18n.ru.ts`, and
  `i18n.test.ts` fails when a literal key has no translation. Switching re-renders in place.
- A `Search settings` field (`inputClass.sm`) tops the nav. A query shows every matching
  setting from all categories, grouped under their category's `Section`; categories
  without a hit fade to `opacity-50`. A setting matches when every word is in its
  name, hint or keywords (accents ignored), or the query is a subsequence of its name
  (3+ chars, e.g. `shthk`). Matched words, or a fuzzy hit's letters in the name, get an
  amber-tinted background (`::highlight(settings-search)` in index.css). Escape clears the query before it closes the dialog;
  clicking a category clears it too.
- Fleet (`Network` rail icon, first in the bottom group) lists every tailnet machine from
  `tailscale status` (`server/fleet.ts`), this PC first: a green/`neutral-700` online dot,
  name, `os · ip · ssh <alias>` subline, pwi state as `text-meta` (running `green-400`,
  dev mode `amber-400`, stopped, not on the tailnet), then `Start pwi` (`Button sm`, only
  when online and not running), a terminal `IconButton` and the Tailscale mark as an `IconLink` to
  `http://<magicdns>:8890/`. Links are tailnet only, no ssh forwards. The ssh alias is the
  `~/.ssh/config` host named like the machine or pointing at one of its addresses, else
  the MagicDNS name.
- Fleet's terminal lives in the page, under the list (list capped at `max-h-1/2`): one
  shell per machine, a login shell in `~` that types `ssh <alias>` (a local shell for this
  PC), kept on the server and remembered per browser (`pwi:fleetShells`), so reopening
  the page lands back in it. The terminal button shows that machine's shell (`outline`,
  `aria-pressed`, row `neutral-900` while shown); a `PanelHeader` with the machine name
  and ✕ (kills the shell) sits over it. Fleet shells never appear in a project's dock.
  Escape inside it goes to the shell, not the dialog.
- Stats uses the dialog's width: usage beside the summary tiles (1/3 + 2/3), a 52-week
  heatmap full width, answer time beside by-hour, Machines (when there are others) /
  Models / Projects / Tools in columns, then Tool calls, then Slowest calls, Largest calls
  and Background jobs in three columns, then every answer (50 at a time, more as the end
  scrolls into view). The grids stack below `md`.
- Tool calls ranks the top 15 tools, bash split by program (`bash: git status`), by
  Tokens / Time / Calls (header `Button sm`, `subtle`/`ghost`, `aria-pressed`). Mono name,
  an `amber-500` bar of the chosen metric, then calls, tokens, total time, per call and
  Hooks (other extensions' share of the time, `–` when nothing was measured); the chosen
  column is `neutral-200`, the rest `neutral-500`. A `text-meta` note says how both are
  measured and what share of calls the tool-metrics collector timed. A measured bash call
  counts per command (`bash: cat`, `bash: pnpm typecheck`), its time outside them as
  `bash: (shell)`. Slowest and Largest calls list single calls, or a measured bash call's
  commands (tool, command or path, value); Background jobs lists what `&` left running,
  longest first, with how long it ran. The `title` adds when, the project and the prompt.
- Stats covers other machines too: every concrete `Host` in `~/.ssh/config` with pi
  sessions is mirrored over rsync (`server/machines.ts`), no config of its own. The
  header filters All / This PC / one button per machine (ssh alias), the same way as
  the Packages tabs (`subtle`/`ghost`, `aria-pressed`); a machine's tooltip says when it
  synced or why it is unreachable. Shown only once another machine exists. Stats shows
  what is on disk first, then `Syncing machines…` beside Refresh until the sync lands.
  Remote projects read `alias:project`; remote answers carry the alias. Heatmap cells are square with no radius,
  `neutral-800` for empty days, then `green-900/700/500/300`. Bars are `amber-500`.
- Under the usage bars, a `text-meta neutral-500` line: `Claude Max renews 22 Oct (in 24 days)`.
  Anthropic gives no end date, so it is the next monthly anniversary of
  `subscription_created_at` (oauth/profile), explained in its `title`. A non-active
  subscription shows its status in `red-400` instead.
- Pace sits full width under usage and the tiles: one card per live limit window
  (`md:grid-cols-3`), a canvas spanning the window start to reset, 0–100%. Solid
  `amber-500` is use so far (server samples every 10 min), dashed is the window's
  average pace carried to the reset (`red-400`, ending in a dot, when it hits 100%
  first), a dashed `neutral-600` diagonal is the even pace. Under it a verdict
  (`green-400` on pace, `red-400` runs out, `neutral-400` under 5% of the window gone)
  and a `neutral-500` line: average rate, budget rate for the rest of the window
  (%/h for the session, %/day for weekly), and prompts left at the window's average.
- The heatmap is a canvas, so cells and ~2px gaps are whole device pixels at any
  display scaling. It reads its colors from the legend swatches.
- By hour has a y-axis: a round step (1, 2 or 5 times a power of 10, at most four above zero) with
  `neutral-800` gridlines, bars scaled to the top gridline. Hour labels (every 3h)
  are centred under their own bar. Like the heatmap it is a canvas snapped to
  device pixels (`useWidth`, `bgColor` in Stats.tsx); axis labels are HTML.
- Heatmap labels are `text-caption neutral-500` HTML beside the canvas: every weekday
  centred on their rows; each month starts over the column holding its 1st, January
  and the first label carry the year, and a label that would touch the next is dropped
  (the leftmost partial month gives way first).

## Primitives (`src/web/ui.tsx`)

New UI uses these; convert raw markup when you touch it. Tune styles in
`ui.tsx`, never at call sites. `className` is for layout only (margin, width, flex).

| Primitive       | Props                                                       | Use |
| --------------- | ----------------------------------------------------------- | --- |
| `Button`        | `variant`: primary / secondary (default) / subtle / ghost / warning (inside amber notices); `size`: sm (12px) / md (13px) | Text buttons. One `primary` per dialog or panel. Cancel is `secondary`. |
| `IconButton`    | `label` (required; aria-label + tooltip), `variant`: ghost / outline / solid, `size`: sm 24px / md 28px, `round` | Icon-only buttons. `round` only in the composer toolbar. |
| `MenuItem`      | button props, `icon?` (16px Phosphor, fixed slot, greys with the row) | Rows in dropdown and context menus. Context-menu items carry an icon; give every item in one menu an icon or none. |
| `MenuSeparator` | —                                                           | Rule between groups of `MenuItem`s. |
| `ContextMenu`   | `x`, `y`, `label`, `width` (220), `onClose`                 | Right-click menu at the pointer: fixed, clamped on screen, closes on outside click, Escape, scroll, resize. Items call `onClose` after acting. |
| `NavItem`       | `icon` (16px Phosphor), `selected`, button props            | Category row in a page's left nav (Settings): `control-md`, `rounded-sm`, `neutral-800` fill when current. |
| `Section`       | `title`                                                     | Settings group (fieldset + uppercase legend). |
| `OptionRow`     | `selected`, `disabled`                                      | Clickable row wrapping a radio or checkbox. |
| `sectionLabel`  | class string                                                | Uppercase group heading on any element. |
| `inputClass.sm/md` | class string                                             | Inputs and textareas (a string so refs pass through). |
| `IconLink`      | `label`, `href`, `variant`, `size` (as `IconButton`)       | An `IconButton` that is a link, opening in a new tab (Fleet's Tailscale links). |
| `ListRow`       | `selected`, `muted`, `size`: ui (default) / body, button props                           | Tree and list rows (Explorer, Source Control, directory picker). 22px; indent with `style.paddingLeft`. |
| `tabClass(active)` | class string; caller adds `pr-3` (the close button overlays the label) | Session/editor tabs and terminal tabs: flat, full `bar` height, amber 2px underline when active, no fill. The strip is `h-bar` with a hidden scrollbar (`.tab-strip`). |
| `tabClassVertical(active)` | class string | Tabs in a vertical list (terminal dock): full width, `control-md` tall, amber 2px left edge when active. |
| `useBatches(total)` | returns `{ shown, end, more }`                           | Long lists (session list, Stats answers): render `rows.slice(0, shown)`, then `{more && <div ref={end} className="h-4" />}`; 50 more mount when it scrolls into view. |
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
  `pinned-folder chip`, `activity bar item`, `search field`, `search result`.
- xterm reads `--text-body` at mount (Terminal.tsx); it cannot take a class.
- Buttons default to `type="button"`; pass `type="submit"` explicitly.
- No focus outlines. `index.css` sets `:focus-visible { outline: none }`; never add
  `focus-visible:outline-*` classes.

## Open questions

- `ChoiceCard`: two uses (chat questions, package search) — one more and extract.
- Dialog headers (DirectoryPicker, Packages add) use `text-title`
  and are not `PanelHeader`. Candidate: `Dialog`.
- Candidates once they repeat: `Badge`, segmented tabs (Packages).
