# Rehearsal: the website's illustrations

Stageshow asks for this note beside a demo: what it was built from, what was
filmed, and what wasn't.

## Hero (`HeroDemo.tsx`)

Gold: `ai-chat` for the thread (the Request sent, a working state, the answer
streaming at its own height, the record of what it did last). Its layout is a
wide hero in the spirit of `linear`: one window, inset top and left on the
page's ground, off the right and the bottom. Changed: the window is
Soundcheck's Editor in the app's own tokens (`look.css`). The working state is
"Listening", because listening is the product's point. The Timeline beside the
thread is the payoff, its Drop and every Clip after it sliding four bars right
as one while the Build-up Section and its two Clips open into the gap.

Beats: typed (1.5 s), sent, Listening (1.5 s), the answer streaming with the
song changing a third of the way in, the changes settling under it, held.
Plays once; Replay remounts it. Poster: the finished state.

Captured: 1440 wide and 390 (the phone design shows four Tracks, not seven,
and the Assistant under the Timeline), the poster under reduced motion, and
`film.mjs --states --gate` at 1440.

Film: `framing: corner bleed with a 32px gutter above … 40px to its left` → the
top inset is now 40. `jump: ss-spinner width` → the spinner is `flex: none`.
`lands on a transform` (the Build-up Section, the changes row) → both are on
a layer for good (`will-change: transform`). The gate ends `rehearsal passed`.

## Tiles (`Features.tsx`)

Gold: `static-card` and `dark-bento` (pinned, bottom bleed, one surface
leading, real words only on the subject). The Mix Helper tile is a hero
window with a satellite straddling its right edge, over the quiet top end of
the spectrum and clear of the 70 Hz peak it talks about. The DJ and Live
tiles keep their windows whole across, so no real word or face is cut by the
stage; only filler (later bars, the lower lanes) runs off the bottom. In the
Live tile each person is one colour throughout (face, tag, selection),
taken from the kit's own `Avatar` colours for their names.

Captured: 1440 and 390, reduced motion.

## Assumptions

- The page is always dark, as Soundcheck's default theme is. There is no
  light variant of the illustrations.

## Not checked

- The full motion of the Stem Separation tile through `film.mjs` (filmed
  only as stills).
- Safari and Firefox. Filmed in Chrome only.
- A fresh-eye review by someone who didn't build them.
