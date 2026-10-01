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
- Expanded tool calls use structured argument views, not JSON dumps: file paths
  and metadata for reads, terminal-style commands for shell calls, the editor's
  read-only unified diff for each edit replacement (content-height, capped at
  `max-h-64`), content previews for writes, and only the removed/added lines for
  completed anchor-based `replace` calls (`-` red, `+` green); omit context and
  redundant anchor arguments. Other arguments stay visible as key/value rows.
  Results are separated from inputs. Unified diffs in tool output use the same
  added/removed color convention as review diffs. Source-reading tool results strip
  read anchors and common indentation before syntax highlighting; unknown extensions
  remain plain text.
- Tool call lines are always one line; the result preview fades. Tool and group
  chevrons and status indicators never shrink when the preview or label is long.
- Anything that scrolls fades out over 2em at each edge it can still scroll past, so
  you can see there is more: `.scroll-fade-y` on every `ScrollPane` list, `.scroll-fade-x`
  on the tab strips. Each fade grows over the first 2em of scroll and goes over the last.
- Text fades only where it meets an edge. A label that ends mid-row never fades.
- Explorer names and session titles/snippets run to the panel's right edge (their
  rows have no right padding) and use `.fade-edge`: a fixed 2em fade at that edge,
  so any text reaching it fades whether it overflows or just fits.
- Session rows and tabs show the name, else the whole first prompt (or the latest,
  Settings > Sessions > `Session titles`; `sessionLabel`), which runs on to the edge and fades there. Session
  rows have no right padding (`pl-3` only), so that fade sits on the panel's edge.
- Prompt-derived session titles update from the live chat immediately on Send,
  including the first prompt, without waiting for a reply or the disk listing.
- Session list titles (`.session-title`) wrap to Settings > Sessions > `Title lines`
  (1, 2, 3 or All; `pwi:sessionLines`, `data-session-lines` on `<html>`, default 1).
  The last shown line fades at the edge; the pin and state dot sit inline on the first line.
- Code (editor and diff tabs) soft-wraps; continuation rows keep the line's own
  indent (`wrapIndent()`, `.cm-wrapIndent`).
- The file editor shows the active-line background only with an empty selection;
  selecting text hides it so the line and selection highlights do not overlap.

| Token            | Size | Use                                              |
| ---------------- | ---- | ------------------------------------------------ |
| `control-sm`     | 24px | `Button`/`IconButton` `sm`: toolbars, headers.   |
| `control-md`     | 28px | `Button`/`IconButton` `md`: dialogs, composer.   |
| `bar`            | 36px | `PanelHeader`: every panel and editor top row.   |

They are spacing keys, so `h-control-sm`, `size-control-md` and `h-bar` all work.

- Every scrollbar shows only while its pane scrolls (and while its thumb is dragged, or the
  overlay track is hovered for 300ms, so passing over it shows nothing), then fades out after 500ms: `data-scrolling` (`showScrollbarsWhileScrolling`)
  lights the thumb through `--scrollbar-thumb`. xterm's own scrollbar already fades.
- Scrollbars (index.css): Chromium gets a hand-drawn 6px `neutral-700` thumb (the transcript's overlay size), `rounded-sm`,
  flush against the pane edge, no arrows. Firefox keeps `scrollbar-width: thin`.
  Settings > Appearance > `Hide scrollbars` (`pwi:hideScrollbars`, per browser, off by
  default) hides them all via `data-scrollbars="hidden"` on `<html>`.
  The transcript hides its native one (`.no-scrollbar`) and draws a 6px thumb over its
  content with `OverlayScrollbar` (drag it, or click the track to page), so nothing
  reserves a strip at its edges. It shows only while you scroll (wheel, touch, keys),
  hover its track or drag, then fades out after 1s idle; auto-scroll does not show it.
  Lists do the same through `ScrollPane` (OverlayScrollbar.tsx), so row highlights span
  the full width: Explorer, sessions, Source Control, Fleet, command palette, session
  search, directory picker. Use it for any new scrolling list.
Text and icon buttons of the same size share a height and line up in a row.

## Icons

- Phosphor weights `regular`, `bold` and `fill` only. The build strips
  `thin`, `light` and `duotone` (`vite.config.ts`), so those render nothing.

## Color roles

Themes remap `neutral-*`, so components name the neutral step, never a hex.

- Primary text `neutral-100`/`200`; secondary `neutral-300`/`400`; hints `neutral-500`; disabled `neutral-600`.
- Accent and primary action: `amber-*`. Errors: `red-*`. Success: `green-*`.
- Every separator (panel edges, list row rules, table rows) is `border-neutral-800`; no fainter `neutral-900` rules.
- The side panel's, the session list's (px width, 180–640, default 288; replaces the list's `border-l` on wide) and the terminal's resize dividers are 1px `neutral-800` lines like any other edge, drawn as a `border` on a zero-size box (a 1px `bg` box straddles two device pixels under display scaling and looks thicker than the bordered edges); their hit area is an invisible `after` box (9px; 13px on the side panel's), `z-10` so neighbors cannot cover it; the side panel's and session list's lean 2px left (and 10px / 6px right) to stay off the scrollbar to their left. They use the scrollbar's timing: amber after 300ms of hover (100ms fade), timed in JS by `hoverIntent` (ui.tsx) because a CSS `hover:delay-300` still flashed on a fast pass, the resize cursor shows on the same 300ms (a press shows both at once), then 1s after the pointer leaves they fade back over 500ms.
- Themes are picked on the Themes page (`Themes.tsx`, a `PageDialog` page opened from Settings >
  Appearance > `Browse themes`), not in a list: a `repeat(auto-fill,minmax(16rem,1fr))` grid of cards,
  each the app chrome in the theme's palette (title bar, rail with the accent dot, `amber-400` status
  bar) around a fixed pre-tokenized JS snippet in its syntax colors, name under it. Clicking the preview
  sets the app theme (`border-amber-400` when current); `Use for editor` (`Button sm ghost`) gives the
  editor that theme alone, shown as an amber `Editor` label. The header has a search field and
  All / Dark / Light (`subtle` when on, else `ghost`). Order: dark then light (`light` flag in
  `prefs.ts`), built-ins first.
- Appearance shows two rows instead: `Theme` (swatch, current name, `Browse themes`) and `Editor
  theme` (editor swatch, `Match app theme` or the theme's name, and a `Match app theme` reset while
  overridden). One gallery, not two lists, because most people want one theme everywhere.
- VS Code themes (`@shikijs/themes`, converted at build time by `scripts/vscode-themes.ts` into
  `vscodeThemes.json`; mapping in `vscodeTheme.ts`) fill the same 18 `--ct-*` slots, as inline
  variables on `<html>`: editor background → base, a darker sidebar (or the editor darkened) → mantle,
  greys evenly spaced from background to text, accents from the terminal ANSI colors. Peach (amber,
  the primary accent) is the theme's own emphasis color (badge, button, focus ring), so on Dark+ it is
  blue. Accents are lifted to 3:1 against the background. Their Catppuccin entries are hidden, the
  built-ins are those.
- Syntax colors are CSS variables (`syntaxStyle` in `codemirror.ts`): chat code blocks and diffs use
  the app theme's (`--tk-*`; Claude → Dark+/Light+, Catppuccin → its VS Code port), the editor its own
  (`--etk-*`, chrome `--ed-*`). Settings > Appearance > `Editor theme` defaults to `Match app theme`
  (`pwi:editorTheme`). `data-light` on `<html>` marks any light app theme.

## Turn activity and timing

- Replace playful running verbs with an always-visible factual phase and its elapsed time,
  with total turn time underneath. A caret on that line opens the live timing breakdown
  in place; it is not a separate Stats window. Use `text-body` for the current phase and
  `text-meta` for timing details, in the existing chat gutter and measure.
- Distinguish request preparation/dispatch, waiting for model output, response received/waiting
  for model output, receiving reasoning/answer/tool-call arguments, specific running tools,
  retry backoff, compaction, and waiting for user input. Only observed phases are labelled.
  Request hooks do not prove upload completion: do not claim “request delivered”, or separate
  network delivery from provider processing. Missing request telemetry is labelled unavailable.
- Streaming silence of at least three seconds shows “No new output for …”, not an invented
  cause. Phase and total clocks update live even when the provider is silent.
- The default tool mode is `Rounds` (saved ID `phases` is preserved): each user turn contains
  `Round 1`, `Round 2`, … disclosures for model-response/tool cycles. Their compact summaries
  show wall time, observed tool counts, failures, and highlight the active segment while running. Each round
  is a compact `rounded-sm` bordered card with one always-visible `h-2` timed step bar and
  coloured labels/durations for its observed `Requesting`, `Thinking`, `Receiving`, and `Doing`
  steps. No empty phase/subphase disclosures. Opening a round shows received prose/reasoning
  first, then tool calls; omit missing text rather than show empty sections.
  Requesting covers recorded preparation up to the provider-request hook; Thinking covers
  waiting after that hook until visible model output. Tooltips explain that browser delivery
  and exact upload completion are not measured, and Thinking includes hidden reasoning and
  network waiting—not isolated reasoning time. Existing recorded timestamps are preserved;
  `Receiving` includes reasoning, prose and tool-call arguments; `Doing` includes consecutive
  tools and their brief intervening bookkeeping. Retry, compaction and user waits remain distinct.
  Explicit live/collapsed/grouped/hidden preferences are preserved; `Answer only` also uses timed
  phases when available. Unmeasured old turns retain their ordinary work fold.
- The separate round header is removed: the `text-meta` round number, a 12px caret and a clock icon with total wall time sit together at the left. Summary padding is `px-2 py-1`;
  round gaps use `space-y-2`. Round summaries have no progress bar. The compact legend shows each observed step as
  its icon and elapsed time (phase names remain available to assistive technology and tooltips).
  Actual tool rows show the target/path, semantic icon, elapsed duration, and outcome; their
  own arguments/output remain individually expandable. Tool durations do not form a second log.
  Only the final assistant message's trailing answer stays outside the phase folds.
- Requesting is `blue-400` / `ArrowUpRight`; Thinking is `pink-400` / `Brain` in live status and step legends; the bar segments use pink without icons.
  The label and icon are pink; the theme maps `pink-400` to a blend of its red and mauve accents.
  Receiving is `green-400` / `ArrowDownLeft`; Doing is
  `amber-400` / `Wrench`. Retry and user waits use `red-400` with `ArrowClockwise` / `QuestionMark`;
  compaction uses `neutral-400` / `ArrowsInLineVertical`. Icons and labels accompany colour.
- A `Breakdown` disclosure with a clock icon and total elapsed time sits above the work; observed
  phase icons and elapsed times sit beside it on the same row. The current action stays directly
  underneath this row. No overall progress bar. In Rounds mode, the preceding user prompt and its
  breakdown stick together at the top while scrolling through the turn's work, without duplicating
  the prompt.
  For current design review, `Expand work by default` is on by default (`pwi:workExpanded`).
  Rounds and completed tool arguments/output start open. The Transcript settings checkbox
  changes this immediately and persists it; explicit off is respected. Individual disclosures
  can still be collapsed by hand without being forced open by clock/stream updates. Retries before any response remain in
  their current round; later observed request cycles start another. Missing stages are not
  invented for older or incomplete telemetry. Model rounds are not new user-prompt turns.
- Parallel calls overlap and are not added together in wall-clock totals. Individual call
  durations remain available inside their phase.
- Codemode wrappers add no transcript row or disclosure: render child calls directly. Keep its script
  hidden. For a single bash call, strip the codemode completion/wall-time envelope and show its
  combined stdout in that command's result, without repeating its command arguments. Nested bash
  calls render as terminal-style `$ command` rows with captured stdout visible underneath. Suppress
  the wrapper output when it is only a success notice from a non-command tool. For multiple calls,
  combined output may be shown once only when it cannot be attributed to an individual call; never
  claim child output is missing when that combined output is visible. Use each child tool's elapsed
  time, not codemode's separate wall-time string. Read tools use blue `BookOpen` icons; writing
  and editing use amber `NotePencil`; commands use `TerminalWindow`; searches use
  `MagnifyingGlass`; other tools use `Wrench`. Round call counts omit codemode wrappers.
  Do not guess Explore/Modify/Verify stages from tool names or commands. Parent wall time owns
  the outer timeline; overlapping child durations are not added to it.
- Integrated work owns the turn's timing strip; do not duplicate it in the answer footer.
  Other tool modes retain timing next to the answer's copy/fork controls, with the same strip
  visible while collapsed. Timings survive reloads and server restarts in pwi's state directory;
  unobserved historical turns have none.

## Composer

- Text pasted at 2,000 characters or 20 lines becomes a compact `Pasted text N.txt`
  card above the field, rather than filling it. Small pastes stay inline. Cards open
  a text dialog with Close and Save changes, and can be removed before sending.
  They survive draft restoration and remain compact, read-only cards in sent messages;
  editing a message makes them editable again. Full contents travel as fenced text in
  the prompt, not as a filesystem path, so every model receives them without a tool call.

- The box pads `p-3` (12px) on every side. The button row sits `mt-4` (16px) below the typed text.
- Attach, `?` and Send are `bare` round `IconButton`s whose icon fills the button (24px, `size="sm"`,
  no outline or disc, no background even on hover; hover only brightens the icon), like Cursor's. Stop is an `outline` round `sm` `IconButton`; the star is `ghost`.
- Send is a `PaperPlaneTilt`: `neutral-100` when there is something to send, the ghost
  button's disabled `neutral-600` otherwise.
- The `?` button (directly left of Send, so Stop never shifts it) toggles "Ask only":
  a `QuestionMark`, `aria-pressed`. When on, the icon turns `amber-400` and bold so the
  state reads at a glance. Right-click it (or Settings > Sessions >
  `Ask only button`, `pwi:askMode`) to pick `Toggle` (default: stays on until switched
  off) or `One shot` (switches off after each send). The menu marks the current mode
  with a `Check`.
- GPT-6.1 Sol on `openai-codex` has an opt-in `Fast · 2.5× usage` button
  beside reasoning. It starts off, turns amber when selected, and persists per
  session outside model context. The tooltip explains the allowance multiplier
  and account-dependent availability; it is independent of reasoning effort.
  It requests `service_tier: "priority"` only for Sol, and Standard requests
  `"default"`. It is disabled during streaming or saving; old children show
  a restart hint rather than sending an unknown command to the model. Other
  models do not show it, and no global default is changed.
- Reasoning options come from the active session's model, not a universal list.
  Levels mapping to the same provider effort share one option, preferring the
  matching level name (Sol's `minimal` and `low` appear only as `low`). Current
  and starred defaults resolve through that model's aliases without rewriting
  saved settings; switching models recomputes the choices. Distinct levels on
  other models remain separate, and missing mapping metadata preserves pi's list.
- Defaults are starred inside the popups, not in the box: every model and reasoning
  option starts with a star that saves or clears it as pi's startup default
  (`defaultProvider`/`defaultModel`, `defaultThinkingLevel`) without picking it.
  Filled amber for the default, `neutral-600` outline otherwise.
- One model select, providers as `<optgroup>`s, plus the thinking select. Pills are
  sans `text-meta` with `field-sizing-content` so each fits its current option.
  Their popup is styled like a menu via `.pill-select` (index.css, customizable
  `<select>`, Chromium 135+): `rounded-md` neutral-900 surface, `text-ui` rows,
  provider labels as uppercase captions, current option in amber. Other browsers
  show the native popup. Model-catalog requests have a 15-second timeout; a failed
  load shows an error above the composer and a `Retry` button beside the picker,
  rather than leaving it silently disabled until reload.
- The context meter sits in the composer's left group, right of Attach. Git stays in
  the row above the box.
- That row (jump-to-latest and git) floats over the transcript's bottom edge with no
  band or background of its own; the transcript scrolls under it (`pb-[max(3rem,var(--chat-scroll-past))]` keeps its
  last line clear). Settings > Transcript > `Scroll past the end` (`pwi:scrollPastOn`, on by
  default, like Cursor) adds room under the last message: `Amount` (`pwi:scrollPast`, 0–90% of
  the window height, default 25) is a `FadeField` shown while on; `applyScrollPast` sets `--chat-scroll-past`. No gap between the transcript and the box: the transcript fades from 8px
  (the buttons' gap to the box) above the top of the git buttons to 0.2 opacity at the box's top edge (`.fade-bottom`), along
  `0.2 + 0.8(1-t^1.5)^3`: it eases in, dims fast, and settles at 0.2, never black.
  Settings > Appearance > `Chat fade` is a checkbox row (`pwi:chatFadeOn`, on by default;
  off removes the mask and hides its controls). While on, a `GearSix` (20px) button beside it,
  square and as tall as the row (`self-stretch aspect-square`, the row's hover fill,
  `neutral-800` while open), collapses or expands its controls, with `Reset` shown while expanded; `Expand setting
  details` (`pwi:settingsExpanded`, on by default) sets whether such panels start
  expanded, and flipping it applies at once. The controls (`pwi:chatFade`, per browser) tune it live with
  sliders for Length, End opacity, Ease in and Drop, plus `Reset`; `applyChatFade` in
  `prefs.ts` builds the gradient into `--chat-fade`. The fields share one
  `grid-cols-[auto_1fr]`: names in the first column so every description (`text-meta
  neutral-500`) starts at the same edge, and under each name a typeable mono number
  (`inputClass.sm`, `w-16`: a stretched number input sizes the column to ~20 characters) left of a `.range` slider (index.css: 4px `neutral-700` track, amber
  up to a 12px amber thumb). Under the sliders, a preview: the
  curve as an SVG chart (x opacity, y position, dashed lines at the fade start and the box)
  beside a sample answer masked by the live gradient over a mock message box, both the
  same height so their rows line up. Tried and
  rejected: `0.2 + 0.8(1-t)^3` (entry too abrupt), linear / CIE L*-even (felt like it darkened faster and faster), Larsen's scrim
  (worse still), pure `(1-t)^3` (right start, but a near-black band above the box) and
  `0.8(1-t)^4 + 0.2(1-t^4)` (held dim, but still ended at zero).
- In a narrow pane the box and the user pill keep 24px to the pane's sides, the same as the
  box's gap to the bottom (`pb-6`): `.chat-gutter`'s minimum is `2.25rem` (24px + the 12px overhang).
- The box overlaps the transcript by its radius (`-mt-3`), so text shows behind its
  corners, and sticks out of the reading column by its padding (`-mx-3`), so the typed
  text lines up with the response text, like Cursor. To keep that exact, the transcript
  reserves its scrollbar on both sides (`scrollbar-gutter: stable both-edges`) and the
  box's edge is an inset `ring-1 ring-neutral-700` (Commit & Push's border colour, the same
  focused or not), not a border. The git row's right edge follows the box,
  `mb-2` above it (the same gap as between its buttons), every button `control-md` tall. It is a ring in a ghost round `IconButton`, `size="sm"`, as wide as the other composer buttons (~24px outer edge: a `size-7 shrink-0` SVG with `stroke={1.5}`, so the flex button cannot shrink it)
  (`neutral-700` track, `neutral-400` fill, amber from 75%, red from 90%), drawn empty
  before the first turn instead of hidden.
- Clicking the ring opens `ContextPanel` above the box (`rounded-md`, like Cursor's):
  - Header: a 56px ring with the % inside, `~used` in `text-title` over `/ window tokens`,
    then a `text-meta` line with what is free and the largest single piece.
  - A full-width `h-2` stacked bar of what the USED part is made of (not scaled to the
    window, so small parts still show). Each segment is its own `rounded-full` pill,
    `gap-0.5` apart, with no track behind them.
  - One `ListRow` per part: caret, `size-3` swatch, label, piece count, % of used, tokens.
    Colors are Cursor's, as `ctx-*` tokens in `@theme` (fixed, not themed): System prompt
    `ctx-system` gray, Tool definitions `ctx-tools` purple, Rules `ctx-rules` green, Skills
    `ctx-skills` orange, Personality `ctx-personality` (Cursor's subagent blue), Conversation
    `ctx-conversation` plum. Empty parts hide.
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
- Clicking an image thumbnail (staged or sent) opens an image workspace, centered across
  the window above the composer's last line. No backdrop: a `border-2 border-neutral-200`
  `rounded-md` frame with `shadow-2xl`; the rest of the app stays usable. Only the visible
  header ✕ or Escape closes it, never a click on the image. Wheel zooms around the cursor;
  Fit / 100% / + / − control zoom, Pan drags the image, and the bottom-right handle resizes
  the viewport.
- Image annotation tools are Select, Arrow, Rectangle and Pen, with color, stroke width,
  undo, redo and delete. Select drags existing marks; color/width changes in Select apply
  to the selected mark. Labels are stable English prompt identifiers (Area 1, Arrow 2,
  Pen 3), never renumbered after deletion. Original pixels remain untouched, under an SVG
  layer. Editable marks survive closing/reopening in the current chat view, but are not
  persisted across reloads or session switches.
- Selecting a mark offers a description and explicit Add to prompt. This stages a PNG
  snapshot of the image plus all labeled marks, replacing its staged original (or the
  previously staged snapshot), and appends a visible image/mark reference with color,
  image-relative percentage bounds and an arrow's tip. A sent image is staged as a new
  attachment, never changed in the transcript. The composer shows an Annotated image
  chip with the snapshot's mark count; it and the thumbnail reopen the editable source.
  Changes after export require Add to prompt again; nothing attaches silently. The staged
  PNG uses the existing attachment/draft/send path and survives reload when storage allows.
- Placeholder is `Message pi…`; key hints live in the textarea's `title`. The field
  uses `field-sizing-content max-h-60` and grows as you type.

## Tabs

- Session (AI) tabs lead with pi's block mark (`PiMark`, `size-3`) that is also the live signal (see Attention). File tabs use `FileGlyph`, diff tabs `GitDiff`.
- A tab's close ✕ shows only while the pointer is over that tab (or it has keyboard
  focus), active tab included. Touchscreens always show it (`.tab-close` in index.css).
  It floats over the label's end (no reserved padding, a short fade behind it), so
  labels use the full tab width.
- Tabs are split by a `neutral-800` rule on each tab's right edge.
- New session is a `Plus` at the right end of each column's strip, opening in that column:
  a flat square cell the strip's full height, split off by a `neutral-800` rule on its left,
  no radius, tab hover (`neutral-900`). The session list has no New session button.
- Closing a tab never scrolls the strip: tabs to its left stay put and tabs to its right
  slide left. Closed width is kept as trailing space until the pointer leaves the strip.
- A cut-off tab label fades out over its last 2em (`.fade-end`, see Overflowing text).
- When tabs overflow the strip, a tab cut off at either end fades out (`.scroll-fade-x`,
  see Overflowing text). The strip and its labels explicitly disable fades when they
  fit, including after tabs close or the strip resizes.
- Right-click any tab → `ContextMenu`, groups split by `MenuSeparator`:
  1. Session tabs: the session list's menu — `Pin Tab` / `Unpin Tab` (the list's pins),
     `Rename…` (inline in the tab, never `window.prompt`; Enter saves, Escape or blur
     cancels), `Name from first prompt`, `Summarise with pi`. File tabs: `Reveal in Explorer` (opens the Explorer, expands
     down to the file, scrolls to and focuses its row), `Copy Path`. Diff tabs: none.
  2. `Close`, `Close Others`, `Close to the Right` (within that column's strip).
- In a split, only the focused column (the one last clicked or focused) keeps the amber
  underline; the other column's active tab drops to `neutral-600` (`tabClass(active, focused)`).

## Attention

Every session has one state, shown the same way everywhere (`ATTENTION_UI` in `attention.ts`):

| State   | Meaning                                  | Tab `π`            | Dot (tab end, list row) |
| ------- | ---------------------------------------- | ------------------ | ----------------------- |
| idle    | nothing new                              | `neutral-500`      | none                    |
| working | streaming                                | amber, glowing and pulsing | list only, pulsing amber |
| ready   | new activity since this browser saw it   | green, glowing     | list only, green        |
| needs   | blocked on a question (`ask`)            | `red-400`, steady  | red                     |

- The tab's `π` lights up immediately when a prompt is sent, including a new session
  before its file exists; it does not wait for an acknowledgement or streamed output.
- Orange (`amber-400`) means working; green (`green-400`) means done but not checked yet.
  Tabs show these states through the `π` itself, with `drop-shadow-sm drop-shadow-current`
  glow, not a trailing dot. An amber `π` only ever means working.
- "Seen" means on screen in either column while the window is visible and focused.
  Per-browser (`localStorage`), synced across pwi windows.
- Window title: `N ● pwi` — N = ready + needs (omitted at 0), `●` while anything works. No brackets.
- Favicon: the `π` breathes while anything works, turns mint `#5ec98b` (fits the pi.dev logo palette) while a reply is
  ready, and gets a red corner dot while anything needs you.
  It is pi's block mark (`piMark.tsx`, monochrome, never the colored pi.dev logo), white,
  no tile.
  The empty-session mark is the same block mark in `amber-400`.
- The session list sorts needs, then ready, right after pinned rows.
- Under the search bar, an `h-bar` row: the count (`sectionLabel`, `pl-3`) left and the sort
  toggle right as a `Button variant="cell" size="bar"` with a 14px `neutral-500` `CaretUpDown`.
  It cycles `Created` → `Last active` → `Last asked` (last user prompt; moves only when you
  act). The same choice is a radio group in Settings > Sessions > `Session order`.
- Alt+J jumps to the next waiting session: needs first, then the longest-waiting reply.

## Session list

- Pasted text is excluded from prompt-derived titles before previews are shortened.
  Below the title, compact `rounded-sm` / `text-meta` chips show text filenames
  (`FileText`) and numbered image attachments (`Image`). They follow the same
  First prompt / Latest prompt selection as the title, including named sessions;
  clicking the row opens the chat. Attachment-only prompts are titled `Attachments`.
- Settings > Sessions > `Show attachments in sessions` (`pwi:sessionAttachments`,
  per browser, on by default) hides or shows both kinds of chip. It never restores
  pasted contents into titles or hides attachments in the chat. List polls carry
  only attachment labels, not pasted text or image pixels.

- Sessions open in tabs show a 14px `neutral-500` `Eye` at the bottom-right of
  their row, with an `Open in a tab` tooltip and accessible label. Neither the active
  session nor background tabs get a persistent row highlight; hover stays unchanged.
  The eye sits outside the subline's fade, including in search results.
- A row's subline is two icon + value pairs, `gap-3` apart: a 12px `Clock` with the short
  `timeAgo` of the sort's stamp (`20m`, `now`, no "ago") and a 12px `ChatCircle` with the
  count of user messages. Icons `neutral-500`, values `neutral-400`. The full date lives
  only in the tooltip.
- Right-click a row → `Pin to top` / `Unpin`. Pinned rows sort first (in either sort mode)
  and show a 12px filled `neutral-500` `PushPin` in the metadata subline, matching
  the clock and message icons. Pins are per-browser (`localStorage`).
- Right-click a row → `Hide from list` drops it from the list and its search (per browser,
  `pwi:hiddenSessions`; tabs and the search popup are unaffected). While any are hidden, an
  `EyeSlash` `StripCell` at the count row's left of the sort toggle shows them (`Eye` in
  `amber-400`, `aria-pressed`): hidden rows at `opacity-50` with a 12px `neutral-500`
  `EyeSlash` in the subline, and `Unhide` in their menu.
- The same pins apply to the tab strips: a pinned session's tab moves to the front of
  its column and shows the same filled `neutral-500` `PushPin` before the `π`.

## Session search

- Two surfaces, one search (`useSessionSearch` in `searchHits.tsx`):
  - The session list's search bar (the whole `h-bar` row, like the tab strips: a 16px
    `MagnifyingGlass` left, a borderless `text-ui` input) filters the
    list in place, in relevance order; each hit's subline shows the matched excerpt
    instead of the date. The count label reads `Searching…` / `N matches`. Escape clears.
  - The `ArrowsOut` cell at its right end (flat, full height, `neutral-800` rule on its
    left, like the tab strip's `+`), or Ctrl+O from anywhere (captured before
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
- The popup's `TextAUnderline` toggle left of ✕ (or Alt+W in the query), `on` variant while
  pressed, matches whole words only (`fusion` no longer hits `confusion`) and drops the
  fuzzy title matches. Per popup, off by default.

## Command palette

- Ctrl+P from anywhere (captured like Ctrl+O, over the browser's Print) opens
  `CommandPalette`: the same popup shell as session search, a `Command` icon, rows
  `text-body` with the key binding right-aligned `text-ui neutral-500`.
- Commands are listed in `App.tsx` (`paletteCommands`). Toggles name what they will
  do (`Show Terminal` / `Hide Terminal`). Filtering uses Settings' `matches` (words,
  then fuzzy subsequence). Arrows move, Enter runs, Escape or backdrop closes.

## User message bubble

- Assistant replies carry no `ASSISTANT` label; the bubble vs. plain prose already says who spoke.
- A `neutral-800` rule, full pane width, sits mid-gap above each prompt (`TurnSeparator`, `my-6`;
  hidden above the first, which instead sits `pt-6` below the tabs, the box's gap to the bottom). It reaches both edges because the transcript's
  scrollbar is `OverlayScrollbar`, drawn over the content (see Scrollbars). The user row has no bottom padding: the gap above your prompt (between turns)
  is wider than the one under it (to its own answer).
- The pill has the composer's edge (inset `ring-1 ring-neutral-700`) and width: `-mx-3 p-3`
  inside `chat-measure`, so it overhangs the reading column like the box and its text
  lines up with the answer's.
- Under the pill, always shown: the answer footer's shape — `Copy`, `Edit` (`PencilSimple`,
  in Fork's slot, disabled but still shown while a turn runs), then `timeAgo` of when it was sent.

- Text is clamped to 3 lines (`.fade-clamp`, the last line fades). When it overflows, a ghost
  `Button size="sm"` below it toggles `Show more` / `Show less` with a 12px caret.
  Settings → Transcript → `Your messages` picks Collapsed (default), Expanded (starts
  open, `Show less` still shown) or Always full (no clamp, no button); `pwi:userMessages`.
- `Edit` swaps the pill for a copy of the composer box: same ring, field, placeholder and
  removable `Attachments`, then a bottom row with `Cancel` (`Button sm`) and the round
  `PaperPlaneTilt` send. No attach, context or model controls. Enter sends, Escape
  cancels. Sending rewinds the session in place to before that message (pi's `/tree`;
  the old branch stays in the file) and asks again with the remaining attachments.

## Retry notices

- A provider failure and its automatic retries share one notice: warning while retrying,
  one error if retries are exhausted. Successful recovery removes it without clearing
  unrelated extension or compaction notices.

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
- Settings → Transcript → `Message footer` (`pwi:messageFooter`, `data-footer` on `<html>`)
  places the time (`.msg-footer-time`) in both footers: `Together` (default, right after
  the buttons), `Time on the right`, or `Buttons on the right` (time left, buttons right).
- Copy swaps to `Check` for 1.2s. Fork is disabled with the label `Forking…` while
  the new session spawns, then opens it as a tab in the same column.

## Explorer

- The header's buttons are `StripCell`s (`PanelHeader cells`), running to the right edge
  with the close ✕ last: `Expand all folders` (`ArrowsOutLineVertical`; level by level, at most 200 folders,
  hidden ones stay shut) and `Collapse all folders` (`ArrowsInLineVertical`).
  Under it, the project row is the same `h-bar` height: the project `<select>` is the whole
  row (borderless, `pl-3`, `text-ui`, `neutral-900` on hover; the native arrow is hidden and a
  14px `neutral-500` `CaretDown` sits `right-3`, the same inset as the text), then `StripCell`s for
  `FolderPlus` (add) and, for any project but the startup one, `X` (remove).
  No refresh button: needing one means a missed update, which is a bug to fix. The tree
  re-reads the root and every expanded folder after a file operation, each time
  the agent finishes a reply, and when anything changes on disk directly inside the
  project folder or an expanded one (`/api/files/watch`, one non-recursive watch each).
- Git status colours the names with Source Control's tones (`statusStyle`): a file
  also shows its letter at the right edge (`pr-3`); a folder takes its contents'
  tone, or modified's amber when they differ.
- Ctrl/Cmd-click toggles a row into the selection (the first also keeps the row
  clicked before it), Shift-click picks the visible range from the last clicked row.
  Picked rows are `bg-amber-950/60`. A plain click, a click on the empty space or
  Escape clears them. Right-click on a picked row opens the menu for all of them:
  `Add to Chat`, `Copy Path`, `Copy Relative Path`, `Cut`, `Copy`, `Delete`
  (labelled `N items`); anything that needs one target is left out.
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
- Drag and drop: rows drag onto a folder row, a file row (its folder) or the empty
  space (the project) to move there. Files and folders dropped from outside the
  browser (desktop, file manager, the browser's downloads) are uploaded there,
  never overwriting; each name that exists is listed in the error bar. The target
  folder row is `neutral-800`, the project's whole pane `neutral-900`; a closed
  folder a drag rests on for 600ms opens, and the target opens after the drop.
  Dragging a picked row moves every picked row. Uploads have no size limit (streamed
  to disk).
- An upload that looks like taking over a second (estimated from the rate so far, or
  still running at 1s) shows a strip at the panel's bottom: `border-t`, `text-meta`
  `Uploading N files · sent of total · time left`, over a `h-1` `rounded-full` bar,
  `amber-400` on `neutral-800`.

## Source Control

- The header is `PanelHeader cells` like the Explorer's: title, branch, then the close
  `StripCell` flush right (a cell header pushes its first button right).
- Everything above Changes runs edge to edge, rows split by `neutral-800` rules, no inner
  boxes: the commit message textarea (borderless, `px-3 py-2`, `text-ui`, `neutral-900` on
  hover and focus, two `bar`s tall: `h-[calc(var(--spacing-bar)*2)]`); an `h-bar` row with the `Auto-name commits` checkbox (`text-ui`, `pl-3`)
  and the `Sparkle` auto-name `StripCell` at its right end; then `Commit & Push` as a
  `Button size="bar"` (flat, full width). `Initialize Repository` is one too.
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
  jump-to-latest, `data-no-column-menu`). Under a `MenuSeparator` it offers `Copy Chat`,
  `Copy Chat with Reasoning` and `Copy Chat with Reasoning and Tools`: Markdown
  (`chatExport.ts`), a `## You` / `## pi` heading per speaker change, reasoning as a
  `>` quote, each tool as its bold name, args and result in fences, nothing cut. The browser keeps its own menu over selected
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
  pick (default `openai-codex/gpt-6.1-sol`, shared with Settings > Automatic actions), and the compact's cost ratio as a `w-24` input with `Save`. Tool metrics is an `OptionRow` checkbox (on by default) with
  a `text-meta` line saying what it does. Workout (off by default, applies at once) is one too. It is not tied to
  prompts (tried first: a set after each send made prompting feel like a cost). A set is due `Every, min`
  after the last one done or skipped, only between `From, h` and `To, h` (`workoutSchedule`, default 30 min,
  9–22). `GET /api/workouts/plan` (`server/workouts.ts`, `shared/rotation.ts` `plan`) lays out the rest of
  the day: each set tires its muscle groups, halving every 45 min, and the next is the exercise whose most
  tired group is freshest (near ties by a generator seeded from the last set, so the plan holds still
  between polls; never the same twice running). Once a set is due, `WorkoutCard` (mounted in `App`, polls
  every 30s) opens at once in every pwi window, hidden ones too, and a window not on screen or not
  focused also raises a system notification (`requireInteraction`, tag per set) when notifications are
  allowed. It first waited up to 10 min for pi to be busy and only showed in a visible window, and sets
  were missed. The Done countdown starts once the window is visible. It is a modal `<dialog>` centred over a `bg-black/50` backdrop (no blur),
  `w-[min(24rem,92vw)]`, `rounded-md` neutral-950 surface, `shadow-2xl`, asked for so it demands
  attention; only its buttons close it (Escape and outside clicks do nothing). In it: the amber figure (full width) flipping between its start and end poses every
  900ms (`workoutFigures.tsx`, hand-drawn SVG polylines; holds have one pose), the task in `text-title`,
  its muscle groups (`chest · arms · core`, `text-meta neutral-400`), then `Skip` (ghost), `Snooze 10 min`
  (secondary) and a `primary` `Done` that reads `Done in 15s` until the exercise's wait is over (all
  `Button sm`); the dialog takes focus itself, and Enter is Done once it unlocks. Skip and Snooze are kept in
  `workout-state.json` and move the next set like a Done. Done logs the set (`workouts.json`, `server/workouts.ts`). While Workout is on, a nested grid under it
  (`Nested`, `grid-cols-2 sm:grid-cols-5`) shows every exercise as a `rounded-sm` bordered card: its
  animated figure (amber when on, `neutral-700` when off), then a `size-3` checkbox and the name, and its muscle groups in `neutral-500`. The
  plan picks only from ticked ones (`workoutOff` in `pwi-extensions.json`, so new exercises start on);
  the last ticked card's checkbox is disabled. Under the grid, the schedule: `Every, min`, `From, h`,
  `To, h` (`w-20` mono inputs) and one `Save`, laid out like "Your body". With a body saved, each card adds `≈N kcal a set` in
  `neutral-500`. Under the grid, "Your body": Sex `<select>` (`w-24`), Age, `Height, cm`, `Weight, kg`
  (`w-20` mono inputs), one `Save` (`Button sm subtle`, enabled while changed), labels above the fields in
  `text-meta neutral-500`, a red line when the server refuses (`workoutProfile` in `pwi-extensions.json`;
  saving all fields empty clears it). Calories: `shared/calories.ts`, MET × Mifflin–St Jeor resting
  kcal/min × minutes of work (`met` and seconds per `rep` in `EXERCISES`). Under it, Personality (`Personality.tsx`, moved
  from Settings): a `text-ui` heading, the file's path, a mono `textarea` with `Save`
  (`Button sm subtle`) and a status line, then the `Repeat before every reply` checkbox.
  It is re-read each time the page is shown unless there are unsaved edits, and the
  pwi extensions tab stays mounted (hidden) on the other tabs so an unsaved edit survives. Changes
  apply to sessions started afterwards. pwi's own plumbing (rewind, context) is not listed.
- Settings has a `w-48` category nav on the left (`NavItem`s: Appearance, Transcript,
  Sessions, Agent instructions, Automatic actions, Notifications, Shortcuts), like Obsidian; the right side shows only the
  chosen category, `max-w-xl p-6`. Opens on Appearance.
- Agent instructions shows read-only global and selected-project `AGENTS.md` files side by side
  (`md:grid-cols-2`, stacked on narrow screens), using the full Settings content width.
  Each has its full path and scrollable plain-text contents; missing, empty and unreadable files
  are distinguished. Global uses pi’s agent directory; project uses the selected project root.
  Files reload when Settings opens or the project changes. No editing controls.
- Automatic actions has provider-grouped model selects for Commit naming, Session naming,
  Compaction (manual, automatic and SoL-Pi online compaction), and Log reduction (SoL-Pi's
  reducer), all defaulting to `openai-codex/gpt-6.1-sol`. Each saves on pick, independently
  of the chat model, machine-wide. Naming settings override `PWI_NAMING_MODEL`;
  compaction settings are re-read for each operation in sessions started with the pwi
  compaction extension. `Automatic compaction` is an `OptionRow` checkbox above the
  model selects, off by default and persisted per machine. It controls pi's threshold
  and overflow compaction for open, resumed, adopted and new sessions; manual compaction
  remains available. Changing it updates live children without restarting their turns.
  SoL-Pi online compaction remains a separate opt-in in Packages.
  Reducer changes apply to new sessions and trusted project
  SoL-Pi config can override them. Failed model loads show an error and Retry.
- Shortcuts lists every app-wide shortcut (`SHORTCUTS` in `shortcuts.ts`), one row each,
  like Obsidian's Hotkeys: the name, the keys as a `kbd` chip (`rounded-sm bg-neutral-800
  px-1.5 py-0.5 font-mono text-meta`, `Blank` in `neutral-500` when unset), then `sm`
  `IconButton`s: restore default (only when changed), remove, change. Change records the
  next key press with Ctrl, Alt or Meta (Escape or any click cancels; the chip reads
  `Press keys…` on `amber-900/40`); keys taken from another shortcut leave it Blank.
  A binding the browser keeps (Ctrl+T/N/W, Ctrl+Tab…, `RESERVED`) shows its chip
  `bg-red-500/20 text-red-400 animate-pulse` with a tooltip saying it will not work.
  Defaults avoid those keys: Alt+Shift+T reopens the last tab closed in this page load,
  Alt+N starts a session in the last-used column, Ctrl+O, Ctrl+P, Ctrl+`, Alt+J, Alt+1–9.
  Changes live in `pwi:shortcuts`; the palette shows the current keys.
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
- Stats has two tabs in its header, `Overview` and `Workouts` (`Button sm`, `subtle`/`ghost`,
  `aria-pressed`, like the machine filter, which applies to both: each machine running pwi has its
  `workouts.json` mirrored with its sessions, and `/api/stats` returns the sets with their machine). Workouts: first `Today`, side by side, sets and (with a body saved)
  kcal as progress cards: `done / done + planned` (`text-title` over `text-ui neutral-500`), the label
  right, an `h-2` `rounded-full` bar (`amber-500` on `neutral-800`) and `N done, M planned`, planned
  being what the schedule still has today. The plan and the body come inside `/api/stats`, not as
  separate requests: those queued behind the machine sync (the browser's six connections per host are
  mostly held by event streams) and showed `0 planned` and no calories. Then tiles (sets this week, in total, active
  days), then `Sets per day, done and planned` full width: 15 days back, today, 14 ahead (today in the
  middle, labelled `Today` in `neutral-200`, then every fifth day either side). A canvas like By hour
  (same `axis()` y-axis and gridlines, 160px tall, 4px gaps), one column a day stacked by exercise
  bottom up in table order, a 1px gap between segments: done sets solid, planned ones (the rest of
  today, and each coming day planned whole from `From` to `To`, `plan.ahead` from `daysAhead` in
  `shared/rotation.ts`) the same colours at 35% on top. Tooltip: `N done, M planned` and each
  exercise as `done + planned`. Each exercise has its own themed colour token (`ex-*` in `@theme`: one
  `--ct-*` accent each, plank and wall sit mixed). Under it the Exercises table (`max-w-2xl`: the
  figure's first pose `w-12` in `neutral-400`, a `size-2.5` colour dot that is the chart's legend,
  name, today, planned (still to come today, `neutral-500`), this week, total; seconds shown as `20s`).
  With a body saved: kcal tiles (this week, in total, per active day), a `kcal` column in the table, and a Sets / kcal
  toggle (`Button sm`, `subtle`/`ghost`, `aria-pressed`) beside the chart's label that restacks the
  columns by kcal. Without one, a `text-meta` line says where to enter it. Under the chart, side by side:
  `Up next` (the next 8 planned: time or `now`, colour dot, name, muscle groups, then `+N more planned
  today`) and `Muscle load now` (`Bars` of each group's current load, with a `text-meta` line on how
  it decays).
- Stats Overview starts with Provider, Model and Request mode selects (`inputClass.sm`), defaulting
  to All providers / All models / All modes. Request mode offers Standard, Fast, Unknown
  and Mixed; comparisons separate these groups and each answer shows its mode.
  Sol requests record their requested Fast setting outside model context, including Standard.
  Historical Sol runs without a saved setting stay Unknown; settings on unsupported models
  count as Standard. Mixed-mode prompts never enter the Standard or Fast comparison groups. They filter historical summaries, charts, tool metrics
  and answers along with the machine filter; changing provider or machine clears the
  model selection. Model identities include the provider, so identical model IDs never
  merge across providers; unknown providers and mixed-model answers have separate groups.
  Workouts only uses the machine filter.
- Usage remaining names the selected provider (All uses pi's startup provider), using
  this PC's login regardless of machine/model filters. OpenAI (ChatGPT / `openai-codex`)
  reads its subscription limits, Anthropic reads its own, and unsupported or logged-out
  providers show a neutral explanation while historical statistics remain usable.
  Each provider has its own cache and history. Cached usage after a fetch failure is
  marked with its timestamp and hides Pace until refreshed; provider switches cancel
  old browser requests so old limits cannot replace the new selection.
- Model comparison uses a two-column grid of `rounded-sm` bordered cards (one column
  below `md`): provider/model name in `text-ui`, metrics in `text-meta`. Each shows
  sample size, median/p90 answer time, average input/output tokens, tools and estimated
  cost per prompt, generation TPS (with measured sample count), and errors/aborts. Input includes cached tokens.
  Generation TPS divides output tokens by first-to-last output delta time, including reasoning
  and tool-call generation but excluding initial latency and tool waits. Provider buffering
  can affect the measurement. Model TPS is total measured output / total generation seconds,
  not an average of rates. Each answer shows its TPS; old or incompletely timed answers show `–`.
  Timing is persisted outside model context by a built-in extension for newly started pwi sessions. A note says these
  are recorded performance metrics, not quality scores or subscription charges;
  answers using multiple models are kept separate rather than credited to the final model.
- Stats uses the dialog's width: usage beside the summary tiles (1/3 + 2/3), model
  comparisons, a 52-week heatmap full width, answer time beside by-hour, Machines (when there are others) /
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
- Under the usage bars, a `text-meta neutral-500` line shows the provider's plan.
  For Anthropic it can say `Claude Max renews 22 Oct (in 24 days)`; Anthropic gives no end date, so it is the next monthly anniversary of
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
  Window duration comes from the provider when available (OpenAI plans can report a
  weekly primary window); the five-hour/week lengths are only fallbacks. Prompt counts
  use this PC's single-model answers from the selected provider, not a Claude-name regex.
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
| `Button`        | `variant`: primary / secondary (default) / subtle / ghost / warning (inside amber notices) / cell (with `size="bar"`: a text `StripCell`, full height, `neutral-800` rule on its left); `size`: sm (12px) / md (13px) / bar (13px, flat, `h-bar`, flush with the panel's edges) | Text buttons. One `primary` per dialog or panel. Cancel is `secondary`. |
| `IconButton`    | `label` (required; aria-label + tooltip), `variant`: ghost / outline / solid, `size`: sm 24px / md 28px, `round` | Icon-only buttons. `round` only in the composer toolbar. |
| `MenuItem`      | button props, `icon?` (16px Phosphor, fixed slot, greys with the row) | Rows in dropdown and context menus. Context-menu items carry an icon; give every item in one menu an icon or none. A description goes under the label (`block text-meta text-neutral-500` span), never beside it. |
| `MenuSeparator` | —                                                           | Rule between groups of `MenuItem`s. |
| `ContextMenu`   | `x`, `y`, `label`, `width` (220), `onClose`                 | Right-click menu 6px off the pointer (right and below, flipped to the other side where it would not fit): fixed, clamped on screen, closes on outside click, Escape, scroll, resize. A second right-click within 500ms at the same spot (4px) closes it and shows the browser's own menu instead (`nativeMenuOnDoubleRightClick`, anywhere in the app). Items call `onClose` after acting. No vertical padding: item hovers run flush to its top and bottom edges; its items are `px-2 py-2` (edge to icon = icon to text; dropdown items stay `px-3 py-1.5`) and its separators have no margin. |
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
| `PanelHeader`   | `title?`, `onClose?`, `closeLabel?`, `cells?`, children     | Top row of a side panel or editor tab. Children go after the title. `cells`: children are `StripCell`s and the close is one too, flush to the right edge. |
| `StripCell`     | `label` (aria-label + tooltip), button props                | Flat square icon cell the row's full height, `neutral-800` rule on its left, no radius, `neutral-900` hover: the tab strip's `+`, session search's `ArrowsOut`, the Explorer header and project row. 16px icons. |

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
  `pinned-folder chip`, `activity bar item`, `search field`, `search result`,
  `range slider`, `settings gear`, `the whole row, like the session search field`
  (the Explorer's project select).
- xterm reads `--text-body` at mount (Terminal.tsx); it cannot take a class.
- Buttons default to `type="button"`; pass `type="submit"` explicitly.
- Number inputs have no spin arrows (index.css); they are typed into.
- No focus outlines. `index.css` sets `:focus-visible { outline: none }`; never add
  `focus-visible:outline-*` classes.

## Open questions

- `ChoiceCard`: two uses (chat questions, package search) — one more and extract.
- Dialog headers (DirectoryPicker, Packages add) use `text-title`
  and are not `PanelHeader`. Candidate: `Dialog`.
- Candidates once they repeat: `Badge`, segmented tabs (Packages).

## Conversation rendering

- Settled conversation rows use the free MIT-licensed `react-virtuoso`, with a 200px
  buffer above and below the visible area. Variable heights are measured automatically.
- Keep the existing transcript scroll container, overlay scrollbar, and scroll-past floor.
  Follow growing content only while pinned within 24px of the bottom; jumping to latest
  resumes following. A session opens at its latest turn.
- Memoize history rows. Live content, notices, and the question panel remain mounted
  outside the virtual history so a typed question answer survives scrolling.
- Native browser find only sees mounted history; offscreen row-local disclosures can
  reset when remounted. Virtualization is per row, not inside a single large tool output.

## Chat code blocks

- Code blocks keep to the reading column (`chat-measure`) and soft-wrap like the editor:
  continuation rows keep the line's indent (`.code-line`, same rule as `.cm-wrapIndent`). No horizontal scroll.
- They use the editor's Dark+ token colours when the fence's language is known (name or
  extension, `codeHighlight.ts`); plain `neutral-300` otherwise and while the colour loads.
- A finished `svg` block is drawn as the image itself (`<img>` from a data URL, so its
  scripts never run; `h-48`, no box, background or padding; a 1px `neutral-700` border on hover marks its edges). Under it a `Code` disclosure line
  (the `Thought` style) opens the code block. While it streams it is plain code.
- Right-click the drawn SVG → `ContextMenu`: `Copy as PNG` (1024px on the long side) and
  `Copy as SVG` (the code).
