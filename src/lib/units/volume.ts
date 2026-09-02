export type VolumeUnit = 'ml' | 'l' | 'fl_oz' | 'cup' | 'half_gallon'

export const ML_PER_US_FLUID_OUNCE = 29.5735295625
export const ML_PER_US_CUP = 236.5882365
export const ML_PER_HALF_US_GALLON = 1_892.705892

export function volumeToMl(value: number, unit: VolumeUnit): number {
  const ml = unit === 'ml'
    ? value
    : unit === 'l'
      ? value * 1_000
      : unit === 'fl_oz'
        ? value * ML_PER_US_FLUID_OUNCE
        : unit === 'cup'
          ? value * ML_PER_US_CUP
          : value * ML_PER_HALF_US_GALLON
  return Math.round(ml)
}

export function mlToFluidOunces(valueMl: number): number {
  return valueMl / ML_PER_US_FLUID_OUNCE
}

export function formatHydrationVolume(valueMl: number, imperial: boolean): string {
  if (imperial) {
    const ounces = mlToFluidOunces(valueMl)
    return `${Number.isInteger(Math.round(ounces * 10) / 10) ? Math.round(ounces) : (Math.round(ounces * 10) / 10).toFixed(1)} fl oz`
  }
  if (valueMl >= 1_000) return `${(valueMl / 1_000).toFixed(valueMl % 1_000 === 0 ? 0 : 1)} L`
  return `${valueMl} mL`
}
