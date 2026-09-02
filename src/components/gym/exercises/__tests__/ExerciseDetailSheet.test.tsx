import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ExerciseDetail,
  ExerciseDetailResponse,
  LoadCorrection,
  LoadCorrectionPreview,
} from '@/lib/gym-client/types'
import { ExerciseDetailSheet } from '../ExerciseDetailSheet'

const gymClient = vi.hoisted(() => ({
  applyLoadCorrection: vi.fn(),
  listLoadCorrections: vi.fn(),
  patchGymExercise: vi.fn(),
  previewLoadCorrection: vi.fn(),
  revertLoadCorrection: vi.fn(),
  useGymExercise: vi.fn(),
}))

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/lib/gym-client/fetch', () => gymClient)
vi.mock('sonner', () => ({ toast }))

const EXERCISE: ExerciseDetail = {
  id: 'bayesian-curl',
  name: 'Bayesian Bicep Curl',
  category: 'strength',
  equipment: 'cable',
  primaryMuscle: 'biceps',
  secondaryMuscles: [],
  regions: [],
  tracks: 'weight_reps',
  isCustom: false,
  aiFilled: false,
  tracked: true,
  disliked: false,
  sets: 192,
  lastPerformed: '2026-07-08',
  hasImages: false,
  slug: null,
  imagePath: null,
  instructions: [],
  images: [],
  defaultRestSeconds: 90,
  restSecondsWarmup: 60,
  preferredUnit: 'lb',
  loadBasis: 'total',
  dislikeReason: null,
  level: null,
  force: null,
  mechanic: null,
}

const RESPONSE: ExerciseDetailResponse = {
  exercise: EXERCISE,
  weightUnit: 'lb',
  distanceUnit: 'm',
  records: {
    bestWeight: null,
    bestE1rm: null,
    bestSetVolume: null,
    repMaxes: [],
    excludedFromE1rm: false,
  },
  history: [],
  charts: { e1rm: [], volume: [], bestSet: [] },
}

const PREVIEW: LoadCorrectionPreview = {
  exerciseId: EXERCISE.id,
  source: 'strong-import',
  startDate: null,
  endDate: null,
  divisor: 2,
  affectedSets: 192,
  firstDate: '2024-10-16',
  lastDate: '2026-07-08',
  rawWeightTotal: 7_138.34,
  correctedWeightTotal: 3_569.17,
  minRawWeight: 20,
  maxRawWeight: 85.98,
  minCorrectedWeight: 10,
  maxCorrectedWeight: 42.99,
  rawVolume: 100_390.67,
  correctedMatchedVolume: 100_390.67,
}

const CORRECTION: LoadCorrection = {
  id: 'correction-1',
  exerciseId: EXERCISE.id,
  source: 'strong-import',
  startDate: null,
  endDate: null,
  divisor: 2,
  previousLoadBasis: 'total',
  reason: 'Combined Strong load normalized to per-side weight',
  active: true,
  affectedSets: 192,
  createdAt: '2026-07-16T12:00:00.000Z',
  revertedAt: null,
}

function renderSheet(
  exercise: ExerciseDetail = EXERCISE,
  onExerciseChanged = vi.fn(),
) {
  gymClient.useGymExercise.mockReturnValue({
    data: { ...RESPONSE, exercise },
    loading: false,
    error: false,
  })

  return render(
    <ExerciseDetailSheet
      id={exercise.id}
      onClose={vi.fn()}
      onExerciseChanged={onExerciseChanged}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  gymClient.listLoadCorrections.mockResolvedValue([])
  gymClient.patchGymExercise.mockResolvedValue(EXERCISE)
  gymClient.previewLoadCorrection.mockResolvedValue(PREVIEW)
  gymClient.applyLoadCorrection.mockResolvedValue({
    correction: CORRECTION,
    preview: PREVIEW,
  })
  gymClient.revertLoadCorrection.mockResolvedValue(undefined)
})

describe('ExerciseDetailSheet load semantics', () => {
  it('shows Total and Per side explicitly and persists a Per side selection', async () => {
    const user = userEvent.setup()
    renderSheet()

    const total = screen.getByRole('button', { name: 'Total' })
    const perSide = screen.getByRole('button', { name: 'Per side' })
    expect(total).toHaveAttribute('aria-pressed', 'true')
    expect(perSide).toHaveAttribute('aria-pressed', 'false')

    await waitFor(() => expect(gymClient.listLoadCorrections).toHaveBeenCalledWith(EXERCISE.id))
    await user.click(perSide)

    expect(perSide).toHaveAttribute('aria-pressed', 'true')
    expect(gymClient.patchGymExercise).toHaveBeenCalledWith(EXERCISE.id, {
      loadBasis: 'per_side',
    })
  })

  it('keeps Strong cleanup collapsed on Total, then previews and applies the exact conversion', async () => {
    const user = userEvent.setup()
    const onExerciseChanged = vi.fn()
    renderSheet(EXERCISE, onExerciseChanged)

    const normalize = screen.getByRole('button', {
      name: 'Normalize combined Strong history…',
    })
    expect(screen.queryByText('Strong history cleanup')).not.toBeInTheDocument()
    await user.click(normalize)

    expect(screen.getByText('Strong history cleanup')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect(gymClient.previewLoadCorrection).toHaveBeenCalledWith(EXERCISE.id, {
      startDate: null,
      endDate: null,
      divisor: 2,
    })
    expect(await screen.findByText('192 sets · 2024-10-16 to 2026-07-08')).toBeInTheDocument()
    expect(screen.getByText(/20–85\.98 lb becomes 10–42\.99 lb\/side\./)).toBeInTheDocument()
    expect(screen.getByText(/Matched volume stays 100,391 lb\./)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Correct 192 sets' }))
    expect(gymClient.applyLoadCorrection).toHaveBeenCalledWith(EXERCISE.id, {
      startDate: null,
      endDate: null,
      divisor: 2,
      reason: 'Combined Strong load normalized to per-side weight',
    })
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Corrected 192 Strong sets')
      expect(onExerciseChanged).toHaveBeenCalledWith({ loadBasis: 'per_side' })
    })
  })

  it('shows an active correction on Per side and restores it through Undo', async () => {
    const user = userEvent.setup()
    gymClient.listLoadCorrections
      .mockResolvedValueOnce([CORRECTION])
      .mockResolvedValueOnce([])
    const onExerciseChanged = vi.fn()
    renderSheet({ ...EXERCISE, loadBasis: 'per_side' }, onExerciseChanged)

    expect(screen.getByRole('button', { name: 'Per side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await screen.findByText('192 sets · first to latest · ÷2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Total' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(gymClient.revertLoadCorrection).toHaveBeenCalledWith(
      EXERCISE.id,
      CORRECTION.id,
    )
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Strong weights restored')
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
      expect(onExerciseChanged).toHaveBeenCalledWith({ loadBasis: 'total' })
    })
  })
})

// The user: "I care more about whats displayed in the exercises page ... proper
// capitalization. idc how the database finds it this is just the display."
// The catalog stores lowercase ("band alternating v-up") and the TOOLS already
// title-case on the way out — but no gym UI component did, so the page showed
// raw database casing. Fixed at the render site specifically, so name MATCHING
// is untouched.
describe('exercise names are capitalized for display', () => {
  it('title-cases a lowercase catalog name in the sheet heading', () => {
    renderSheet({ ...EXERCISE, name: 'band alternating v-up' })
    expect(screen.getByText('Band Alternating V-Up')).toBeInTheDocument()
  })

  it('leaves an already-capitalized name alone', () => {
    renderSheet({ ...EXERCISE, name: 'Pendulum Squat' })
    expect(screen.getByText('Pendulum Squat')).toBeInTheDocument()
  })
})
