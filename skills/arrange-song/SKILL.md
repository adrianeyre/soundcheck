---
name: arrange-song
title: Arrange the song
category: Arrangement
description: Turn a loop into a full song with an intro, verses, choruses, a breakdown and an outro, marked as Sections.
argument-hint: "[structure, such as pop or club] [length in minutes]"
---

Arrange the loop that is in the Project into a whole song.

1. Read the Project for its Clips and any Sections, and find the loop: the bars where most Tracks play. If the song already has Sections, keep them and arrange around them.
2. Pick the structure: for a club track, Intro 16, Build 8, Drop 16, Breakdown 16, Build 8, Drop 16, Outro 16; for pop or anything else, Intro 4, Verse 8, Chorus 8, Verse 8, Chorus 8, Bridge 8, Chorus 8, Outro 4. Scale the bars to the length the musician gives at the song's tempo.
3. Mark the loop as the first chorus or drop with add_section, then copy its Clips with copy_clips (or duplicate_section and move_section) to make each other Section, and add a Section for each.
4. Take Tracks out to shape the energy: the intro and outro are drums and one other part; verses drop the lead and keep the bass; the breakdown or bridge drops the kick and the bass; the last chorus has everything. Delete Clips from the Sections where a Track should be silent.
5. Leave a bar of the Clips before each chorus or drop lighter, such as without the kick, so it lands.

Say the structure, Section by Section, with their bars.
