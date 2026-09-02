import { describe, expect, it } from 'vitest'

import { displayExerciseName, normalizeGeneratedWorkoutName } from '../display-name'

describe('displayExerciseName', () => {
  it('standardizes lower-case catalog names without damaging punctuation', () => {
    expect(displayExerciseName('dumbbell biceps curl')).toBe('Dumbbell Biceps Curl')
    expect(displayExerciseName('3/4 sit-up')).toBe('3/4 Sit-Up')
    expect(displayExerciseName('cable triceps pushdown (v-bar)')).toBe(
      'Cable Triceps Pushdown (V-Bar)',
    )
  })

  it('preserves existing capitalization', () => {
    expect(displayExerciseName('T Bar Row')).toBe('T Bar Row')
    expect(displayExerciseName('90/90 Extensions')).toBe('90/90 Extensions')
  })

  // Issue #1873: naive single-letter title-casing produced "Ez" instead of the
  // acronym "EZ", and capitalized the letter after an apostrophe ("Dancer'S").
  it('renders known acronyms in full caps regardless of source casing', () => {
    expect(displayExerciseName('ez barbell reverse grip curl')).toBe('EZ Barbell Reverse Grip Curl')
    expect(displayExerciseName('Ez Barbell Reverse Grip Curl')).toBe('EZ Barbell Reverse Grip Curl')
    expect(displayExerciseName('rdl deadlift')).toBe('RDL Deadlift')
    expect(displayExerciseName('mag row')).toBe('MAG Row')
  })

  it('does not capitalize a letter after an apostrophe, and corrects it if already wrong', () => {
    expect(displayExerciseName("dancer's stretch")).toBe("Dancer's Stretch")
    expect(displayExerciseName("Dancer'S Stretch")).toBe("Dancer's Stretch")
  })

  it('capitalizes both sides of a hyphenated word', () => {
    expect(displayExerciseName('lever bent-over row with v-bar')).toBe('Lever Bent-Over Row With V-Bar')
  })
})

describe('normalizeGeneratedWorkoutName', () => {
  it('normalizes an all-lowercase generated workout name', () => {
    expect(normalizeGeneratedWorkoutName('upper body / pull focus')).toBe(
      'Upper Body / Pull Focus',
    )
  })

  it('preserves intentional mixed casing and trims whitespace', () => {
    expect(normalizeGeneratedWorkoutName('  Push/Pull A  ')).toBe('Push/Pull A')
    expect(normalizeGeneratedWorkoutName('HIIT + core')).toBe('HIIT + core')
  })
})
