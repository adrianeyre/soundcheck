# The Editor is Widgets on a snapping Grid, and every new section is a Widget

**Status: proposed** in the PR that adds the Grid.

The Editor was one fixed column of sections. A musician working on the Mixer had to scroll past the Timeline to reach it, and couldn't keep the Transport in view while doing so. So each section is now a **Widget** that can be dragged, resized, **Pinned** and hidden on a **Grid**, and this ADR is the contract a new section follows to join it.

## Decision

**Hand-written, not a library.** The Grid is [`app/src/grid/`](../../app/src/grid): a pure layout model (`layout.ts`) and one component (`WidgetGrid.tsx`). Grid libraries such as react-grid-layout have no keyboard alternative to dragging, which the app's WCAG 2.2 AA statement needs (2.5.7 Dragging Movements, 2.1.1 Keyboard), and none has Zones that stay on screen while the page scrolls. The model is small enough to own and test without a browser.

**The Grid.** 24 columns wide, 24 px rows, 16 px gaps (`GRID` in `layout.ts`). A Widget covers whole cells, so a drag or resize snaps. Within a Zone, Widgets never overlap: one dropped or grown onto others pushes them down, and one moved down onto the Widgets under it swaps with them (so the arrow keys can move it past them). A Widget the musician moves goes exactly where they drop it, into any blank space: under a Deck shorter than the mixer beside it, say, with blank space between the two if that is where they put it. The rows a change frees by itself close up: when a Widget is shrunk, hidden or pinned away, its content gets shorter, or a page leaves one out, whatever is below the rows it left moves up into them. Blank space the musician made by moving a Widget is theirs, and is kept.

**Zones.** `main` scrolls with the page; `top` is Pinned under the title bar and `bottom` above the footer. The pinned Zones are portalled into slots of their own between the title bar, the page and the footer, outside the page's scroll container: flush against both, the window's full width, and never over whatever has focus (WCAG 2.4.11). A pinned Widget is a full-width, square-cornered band stacked on the others in its Zone; only its height changes, by the edge that faces the page (or Shift and the arrow keys). A Zone can take up to 45% of the window before it scrolls itself.

**Controls every Widget has**, drawn by `WidgetGrid`, never by the Widget:
- a bar to drag it by, whose grip button moves it with the arrow keys and resizes it with Shift and the arrow keys, announcing where it landed;
- a corner to resize it by;
- Pin to top and Pin to bottom toggles, and a cross (×) that hides it;
- a checkbox in the **Grid** menu (Menu → Grid), which shows or hides it, and **Reset layout** there, which puts every Widget back.

**Content stays mounted.** `WidgetGrid` draws each Widget's content once, through a portal into a node of its own that it moves between Zones and only detaches while the Widget is hidden. So hiding or pinning a Widget never unmounts it: a take being recorded, a Request running or a scroll position carries on. The frames are memoised and get stable handlers, so the page's frequent re-renders (meters, the playhead) don't redraw them.

Below 768 px wide there is no room for columns: Widgets stack in Grid order at their natural height and aren't dragged, but can still be Pinned and hidden.

**Persistence.** The layout is kept in local storage under `soundcheck.grid` (listed in the Cookie Policy), never in a **Project**: it's how this musician likes the screen, not part of the song. A saved layout that is missing a Widget, or holds one wrongly, gets that Widget's starting place, so adding a Widget never breaks a saved layout.

## How a new Widget conforms

1. **Register it** in `WIDGETS` in `app/src/grid/layout.ts` and add its id to `WidgetId`: a title (the Grid menu's name for it, in `CONTEXT.md`'s terms), a starting cell clear of the others (a test checks), and a minimum size. The order of `WIDGETS` is the Grid menu's order.
2. **Give `WidgetGrid` its content** under that id in `SongPage`'s `widgets`. Leave it out (`undefined`) where the platform can't offer it; its place is kept, and it isn't drawn.
3. **Render one `.panel` (or `.toolbar`)** with its own heading, as every section already does. The Widget is the frame: it strips that panel's border and background, and scrolls the content when the Widget is smaller than it.
4. **With nothing to show, say so and step aside.** A Widget whose content has nothing to show just now (the Audio Editor until an Audio Clip is selected, the Step Sequencer, Piano Roll and Instrument until a Pattern Clip is selected, Record audio until there is an Audio Track and an input to record from, Samples where there are no sample folders to read) is listed in `SongPage`'s `empty`, and its content is `null`. `WidgetGrid` takes it off the Grid and closes its rows up, and as soon as it has something it comes back where it was, pushing down whatever moved into its rows meanwhile. Its content stays mounted; whether the musician hid it is kept as it was, and the Grid menu marks it "(empty)", so ticking it and seeing nothing is explained. (This replaces an earlier rule that such a Widget always drew an empty state so the layout never moved: an empty Widget took space that nothing used, and the musician asked for it back. The layout now moves when a Pattern Clip is selected or deselected.)
5. **Don't draw your own move, resize, pin or close controls**, don't `position: fixed` or `sticky` anything inside it, and don't assume a width or height: the musician chooses both.
6. **Test it** where it lives, as before; the Grid's own behaviour is tested in `app/src/grid/`.

## Consequences

- Every section of the Editor can be hidden, by the musician or because it has nothing to show, so nothing may depend on another section being on screen. Hidden content is still mounted, so its effects (such as the computer keyboard's notes) keep running; a Widget must not assume it is visible because it is mounted.
- Widgets are fixed heights, so taller content scrolls inside its Widget. That is the price of snapping; a Widget can always be made taller. Each is drawn no taller than its content, so it has no blank space at its bottom, unless the musician made it that tall: a Widget resized taller or shorter keeps the height given it (`sized` in the layout), and its content fills it, so the space is there to use (the Samples tree grows into it). The musician asked for this: dragging a Widget taller only for it to spring back to its content's height took the choice away. "Reset layout" fits every Widget to its content again. The rows under a Widget drawn shorter than it may be are free: the layout keeps a Widget at the height it is drawn, and the most it takes beside that (`room`), so its content can grow back into it, pushing down whatever was put there. Before, it kept the most it takes as its height, so a Deck drawn no taller than its content still held the rows under it and nothing could be dropped there.
- The exception is a Widget whose content grows as it is used, marked `grows` in `WIDGETS`: the Assistant, whose transcript grows with each Request, so the musician can read what it did without scrolling a five-row box. It grows with its content by itself, up to its `grows` rows (20) or the height it was made, whichever is more, pushing down what is below it, and shrinks again with its content; past that it scrolls. What it grew to isn't kept in the layout: its own height is.
- Dragging a Widget between Zones isn't supported; the pin toggles move it.
- The Settings page is not on the Grid.

## Amended: a Grid for each page

The Mixer page (ADR 0013) is Widgets on a Grid too: its waveforms, each Deck, its mixer and its two Track browsers. A Track browser starts *tucked*: drawn directly under its Deck, as wide as it, and down to the mixer's bottom, following their heights as their content is measured, until the musician moves or resizes it. So a Grid belongs to a page, not to the Editor alone.

- **Each page's Widgets are listed apart:** the Editor's in `WIDGETS` and the Mixer page's in `MIXING_WIDGETS`, both in `PAGE_WIDGETS`. A layout holds only one page's Widgets, and every function in `layout.ts` works over the Widgets the layout it is given holds (`specsOf`). So moving, hiding or pinning a Widget on one page never touches the other's.
- **Each page's layout is kept apart:** the Editor's under `soundcheck.grid`, as before, so no saved layout is lost, and the Mixer page's under `soundcheck.grid.mixing`. Both are listed in the Cookie Policy.
- **The Grid menu is the open page's:** its Widgets, which are empty, and a Reset layout for that page. Settings has no Grid, so it has no Grid menu.
- **Only the open page's pinned Widgets are drawn** in the slots under the title bar and above the footer. A hidden page's pinned Widgets are drawn in their own page, which is hidden, and stay mounted.
- A new Widget on either page follows the steps above, in its page's list.

## Amended: the Pads page's Grid

The Pads page is a third page with a Grid of its own, as the Mixer page is: its Widgets are listed in `PADS_WIDGETS` (the Pad Controller the Grid's whole width, a Track browser under it), its layout is kept under `soundcheck.grid.pads`, listed in the Cookie Policy, and the Grid menu and Reset layout are its own while it is open.

A Widget can start hidden (`startsHidden` in its spec): it is on its page's Grid menu, unticked, until the musician shows it, and Reset layout hides it again. The Mixer page's Pad Controller starts that way, so the Mixer page opens as it did.
