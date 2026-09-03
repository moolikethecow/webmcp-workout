/**
 * The prompts the demo is built around — verbatim, because they are the script
 * (docs/DEMO_SCRIPT.md) and the submission's testing instructions. The
 * dashboard shows them with a copy button so a judge can paste rather than
 * retype.
 */

/** The three the video is cut around. Do not reword. */
export const DEMO_PROMPTS = [
  "My shoulder's bugging me and I've got 30 minutes. Keep what I've done, work around the shoulder, hit whatever's freshest.",
  'What should I do next?',
  'Before I go heavier on incline bench, am I actually progressing?',
] as const

/** The two that show the form tool and gym switching. */
export const MORE_PROMPTS = [
  'My left shoulder is bad today — note it as limiting.',
  "I'm in a hotel gym this week — dumbbells and a smith machine, that's it.",
] as const

export interface DemoPrompt {
  text: string
  /** Where to be when you say it. */
  where: '/' | '/gym'
  /** What to watch for. One line. */
  shows: string
}

export const DEMO_PROMPT_GUIDE: DemoPrompt[] = [
  {
    text: DEMO_PROMPTS[0],
    where: '/gym',
    shows: 'Completed sets stay; the rest is rebuilt from the eligible pool only.',
  },
  { text: DEMO_PROMPTS[1], where: '/gym', shows: 'Reads the live session and the plan, not the chat history.' },
  { text: DEMO_PROMPTS[2], where: '/gym', shows: 'Cites six sessions and the progression rule that produced the number.' },
  {
    text: MORE_PROMPTS[0],
    where: '/',
    shows: 'The constraint form fills in and stops. Nothing is recorded until you press Add.',
  },
  { text: MORE_PROMPTS[1], where: '/', shows: 'The catalog narrows to the room, and the reply says by how much.' },
]
