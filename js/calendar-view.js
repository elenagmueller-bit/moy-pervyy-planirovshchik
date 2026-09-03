import { formatLocalDate, getWeekDates, todayString } from "./date-utils.js";

const WEEKDAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderWeekCalendar(visibleWeek) {
  const card = element("section", "page-card calendar-card");
  card.dataset.view = "calendar";

  const heading = element("header", "page-heading");
  const headingCopy = document.createElement("div");
  headingCopy.append(element("h1", "", "Календарь"), element("p", "", "Неделя готова к вашим планам"));
  const hint = element("span", "eyebrow", "Локальное время");
  heading.append(headingCopy, hint);
  card.append(heading);

  const grid = element("div", "week-grid");
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", "Недельный календарь");
  const dates = getWeekDates(visibleWeek);
  const today = todayString();

  grid.append(element("div", "week-grid__corner"));
  dates.forEach((date, index) => {
    const header = element("div", `week-day${formatLocalDate(date) === today ? " is-today" : ""}`);
    header.setAttribute("role", "columnheader");
    header.append(element("span", "week-day__name", WEEKDAY_NAMES[index]), element("span", "week-day__number", String(date.getDate())));
    grid.append(header);
  });

  grid.append(element("div", "week-grid__label", "Без времени"));
  dates.forEach(() => grid.append(element("div", "all-day-cell")));

  for (let hour = 6; hour < 23; hour += 1) {
    grid.append(element("div", "time-label", `${String(hour).padStart(2, "0")}:00`));
    dates.forEach((date) => {
      const cell = element("div", `time-cell${formatLocalDate(date) === today ? " is-today" : ""}`);
      cell.dataset.date = formatLocalDate(date);
      cell.dataset.hour = String(hour);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", `${date.toLocaleDateString("ru-RU")} с ${hour}:00 до ${hour + 1}:00`);
      grid.append(cell);
    });
  }

  card.append(grid);
  return card;
}
