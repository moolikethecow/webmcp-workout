# Demo video script (target 2:55, hard cap 3:00)

Record on https://gym.mootoo.co in a fresh browser profile (fresh workspace). Use the ChatGPT desktop app's built-in browser from a **Work or Codex** chat on **GPT-5.6 Sol or Terra** (not Luna, not the web app); keep the app visible on the left and the chat on the right. Before recording: open /gym, start "Repeat last workout" (Full Body), and complete nothing yet.

| Time | On screen | Say |
|---|---|---|
| 0:00 | Logger with Full Body running. | "Most AI fitness apps generate text. This one shares the workout itself: the logger I tap at the gym and the tools the agent calls read and write the same live session." |
| 0:15 | Tap set 3 of Cable Middle Fly done. Row turns green, header ticks. | "I log a set by hand. Normal tracker." |
| 0:30 | Type in ChatGPT: *My shoulder's bugging me and I've got 30 minutes. Keep what I've done, work around the shoulder, hit whatever's freshest.* | "Now the agent. It reads the live workout, records a shoulder constraint, checks which muscles are fresh, searches only the exercises the constraint allows, and edits the part I haven't done." |
| 0:55 | Tool calls appear; logger rows change: shoulder press becomes a leg movement, sets shrink, my completed set stays green; the strip reads "Agent: Replaced…" | "Watch the logger. The set I finished didn't move. The replacement came from the eligible pool, not from the model's imagination. Every edit carried the session revision, so a stale edit would have been rejected." |
| 1:25 | Tap another set done by hand. Type: *What should I do next?* | "I keep training. The agent re-reads the session and sees what I just did." |
| 1:45 | Type: *Before I go heavier on incline bench, am I actually progressing?* | "History and rules live in the app. Six sessions, a double-progression policy, top of the range on all three sets, so the next target is eighty." |
| 2:05 | Dashboard. Ask: *my left shoulder is bad today — note it as limiting.* The constraint form fills in — region, severity, "left shoulder" — **and stops**, highlighted *Filled in by your agent*. Pause on it. Then press Add yourself. | "This one is a form, not a registered tool. In Chrome the markup is the tool. In ChatGPT's browser, which has no declarative API, the same name is registered in code and points at the same form. Either way the agent can put a claim about my body on screen. It can't commit it. I press the button." |
| 2:30 | Readiness figure and the new constraint in the list. | "Fourteen tools on document.modelContext plus that form — same origin, no API keys. What the agent may do alone is registered in code. What needs my hand is a form." |
| 2:45 | Repo README, then the app. | "The open surface of Stark, a larger private system. AGPL. Every visitor gets a private workspace." |

Cuts if long: shorten 2:30 to the one sentence about the split. **Never cut 0:55 or 2:05** — they are the two beats nothing else in the field will have.

The 2:05 beat works in both clients: Chrome (152 or newer, no flag needed — gym.mootoo.co carries an origin-trial token) publishes the form itself; ChatGPT's browser gets the code-defined stand-in, which fills the same form and waits for your press, returning `awaiting_confirmation` if you take longer than twenty seconds (the values stay on screen — press Add and it records). If the agent says it cannot attach to the tab, the chat is not a Work/Codex session on Sol or Terra.
