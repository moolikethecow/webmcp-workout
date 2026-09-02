# Agent guide

Ten rules for any agent operating this app. They are not app-specific etiquette
— they are what it takes to edit a training session that a human being is in the
middle of performing. Each one exists because ignoring it produces a specific,
recognisable failure.

The tools enforce most of this on the server. The rules are here so an agent
knows *why* it was refused, and so the reasoning survives being ported to
another product.

---

### 1. The workout is a shared artifact

Someone else is editing it: a person with a phone propped against a rack,
tapping a checkmark between sets. You are not the only writer, and you are not
the primary one. Read before you write, every time, and expect the state to have
moved since you last looked.

### 2. Canonical state wins over conversation

What the server returns is what is true. What was said three messages ago is a
memory of what was true. When they disagree, the server is right and you re-read
— never reconcile by writing your recollection back over the data.

Pass `expected_revision` from your most recent read on every mutation. A
`stale_revision` answer is not an error to route around; it is the system telling
you a human did something. Re-read and retry.

### 3. Never infer completed sets from conversation

"I did three sets of ten" is a claim about the past, not a log entry. Only the
logger records performance. If sets are missing from the data, say so and let
the person enter them; do not write performance on their behalf from a sentence.

### 4. Completed performance is preserved by default

A programming change — new weight, new rep target, more sets — applies to
incomplete sets only. It writes the *prescription*; it does not touch what was
actually lifted. Rewriting a completed set is a separate, explicit act
(`apply_to_completed`), reserved for when someone says "I typed 145, it was
135". History that quietly changes is history nobody can trust.

### 5. Warm-ups are not working volume

"Make it four sets" means four working sets. Warm-up ramps are separate, edited
separately, and never counted toward volume, records or progression. Flattening
a warm-up ramp into the working scheme is a silent 40% load error on the first
set of the day.

### 6. Use exercise search before any substitution

Names must match the catalog exactly, and search is filtered to what the current
constraints and equipment allow — so it is both the way to get a valid name and
the way to get a *permitted* one. Never propose a movement you invented from
general knowledge of training. The catalog is the vocabulary.

### 7. Constraints are hard limits, not preferences

A recorded training constraint excludes conflicting movements outright. It is
not a factor to weigh against a good programming reason. If someone wants the
excluded movement anyway, that is a decision for them to make explicitly — not
one to arrive at by argument.

### 8. Readiness is a training-history signal, not a medical one

Readiness is computed from logged sets: days since a region was worked, and
recent working volume. That is all. It is not recovery, not fatigue, not
readiness-to-perform in any physiological sense, and nothing from a wearable
enters it. Cite it as what it is — "you haven't trained back in six days" — not
as a verdict on the person's body.

### 9. Progression rules are explicit — quote them, don't invent them

The next target comes from a stated policy applied to logged sets. It is
arithmetic with a name. Report the rule and the number it produced. Do not
improvise a load because it feels about right, and do not override the rule
without saying that you are overriding it and why.

### 10. No diagnosis, no treatment

Record what someone tells you about what they cannot do, so exercise selection
can respect it. That is the whole scope. Do not name a condition, do not explain
what is wrong with a joint, do not prescribe rehabilitation, stretches or a
return-to-training timeline. "Your shoulder is impinged, do these three
exercises" is out of bounds no matter how confidently the pattern matches.

If someone describes pain that concerns them, say plainly that this is outside
what the app can advise on, and record the constraint so their training respects
it in the meantime.

---

## In one line each

1. Shared artifact — someone else is editing.
2. Canonical state wins; pass `expected_revision`.
3. Never infer completed sets from conversation.
4. Completed performance is preserved by default.
5. Warm-ups are not working volume.
6. Search before substituting.
7. Constraints are hard limits.
8. Readiness is training history, not medicine.
9. Progression rules are explicit — quote them.
10. No diagnosis, no treatment.
