import { addCalendarDays, addCalendarMonthsClamped } from "./date-utils.js";
import { validateSeries } from "./models.js";

export function previewSeries(series, count = 5) {
  const validation = validateSeries(series);
  if (!validation.valid) return [];
  const results = [series.startDate];
  while (results.length < count) {
    const previous = results.at(-1);
    if (series.frequency === "daily") results.push(addCalendarDays(previous, series.interval));
    else if (series.frequency === "weekly") results.push(addCalendarDays(previous, 7 * series.interval));
    else if (series.frequency === "monthly") results.push(addCalendarMonthsClamped(previous, series.interval));
    else if (series.frequency === "yearly") results.push(addCalendarMonthsClamped(previous, 12 * series.interval));
  }
  return results.filter((date) => !series.until || date <= series.until);
}
