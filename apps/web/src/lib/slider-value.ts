/**
 * One number out of what a slider reports.
 *
 * The slider is built for ranges, so it hands back either a number or an
 * array of them depending on how it was given its value. Every slider in this
 * app has one thumb, so each of them would otherwise narrow that union
 * itself, and a reading of NaN would reach a media element as a seek to
 * nowhere.
 */
export function sliderNumber(value: number | readonly number[], fallback = 0): number {
  const first = typeof value === 'number' ? value : value[0];
  return first !== undefined && Number.isFinite(first) ? first : fallback;
}
