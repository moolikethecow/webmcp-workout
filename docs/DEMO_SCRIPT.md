# Demo video script (target 2:40, hard cap 3:00)

Record on https://gym.mootoo.co in a fresh browser profile (fresh workspace). Use ChatGPT's in-app browser; keep the app visible on the left and the chat on the right. Before recording: open /gym, start "Repeat last workout" (Full Body), and complete nothing yet.

| Time | On screen | Say |
|---|---|---|
| 0:00 | Logger with Full Body running. | "Most AI fitness apps generate text. This one shares the workout itself: the logger I tap at the gym and the tools the agent calls read and write the same live session." |
| 0:15 | Tap set 3 of Cable Middle Fly done. Row turns green, header ticks. | "I log a set by hand. Normal tracker." |
| 0:30 | Type in ChatGPT: *My shoulder's bugging me and I've got 30 minutes. Keep what I've done, work around the shoulder, hit whatever's freshest.* | "Now the agent. It reads the live workout, records a shoulder constraint, checks which muscles are fresh, searches only the exercises the constraint allows, and edits the part I haven't done." |
| 0:55 | Tool calls appear; logger rows change: shoulder press becomes a leg movement, sets shrink, my completed set stays green; the strip reads "Agent: Replaced…" | "Watch the logger. The set I finished didn't move. The replacement came from the eligible pool, not from the model's imagination. Every edit carried the session revision, so a stale edit would have been rejected." |
| 1:25 | Tap another set done by hand. Type: *What should I do next?* | "I keep training. The agent re-reads the session and sees what I just did." |
| 1:45 | Type: *Before I go heavier on incline bench, am I actually progressing?* | "History and rules live in the app. Six sessions, a double-progression policy, top of the range on all three sets, so the next target is eighty." |
| 2:10 | Open the dashboard: readiness figure, the constraint, recent training. | "Readiness is derived from logged sets. Constraints are training limits, not diagnoses. Twelve page-scoped tools on document.modelContext, same-origin, no API keys." |
| 2:30 | Repo README, then the app. | "This is the open surface of Stark, a larger private system. Code is AGPL. Try it: every visitor gets a private workspace." |

Cuts if long: drop 2:10's dashboard tour. Never cut the 0:55 beat.
