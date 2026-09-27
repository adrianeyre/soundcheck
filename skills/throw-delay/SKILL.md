---
name: throw-delay
title: Delay throws
category: Mixing
description: Echo the last word or note of a phrase into a tempo-synced delay, then pull it back, for movement between phrases.
argument-hint: "[a Track] [note value, such as 1/4 or 1/8 dotted]"
---

Throw the ends of phrases into a delay, on the Track the musician names, or the vocal or lead.

1. Load the routing, sounds and automation tools. If the Project has a Bus with a Delay, use it; otherwise add a Bus called Delay with a Delay synced to the tempo at the note value the musician gives (a quarter note unless they say otherwise), feedback about 0.45, high cut about 5 kHz and mix fully wet.
2. Add a Send from the Track to the Delay Bus, at 0.
3. Find the last note, or the last onset of an Audio Clip, of each phrase: the note before a rest of a beat or more. Analyse the Track and read its onsets for an Audio Track.
4. Automate the Send's level to jump to about 0.6 at that note and back to 0 at the start of the next phrase, holding in between, so only the ends of phrases echo.
5. Keep it to one throw every 2 or 4 bars, not every phrase, so it stays a moment rather than a wash.

Say how many throws you added and where.
