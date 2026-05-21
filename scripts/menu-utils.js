"use strict";

const MAX_MENU_ITEMS = 50;
const MENU_TIME_ZONE = process.env.MENU_TIME_ZONE || "Europe/London";

function readSourceItems(value) {
  return Array.isArray(value) ? value : value.items || value.dinnerList?.items;
}

function validateMenuItems(value) {
  if (!Array.isArray(value)) {
    throw new Error("Menu JSON must be an array or an object with an items array.");
  }

  return value.slice(0, MAX_MENU_ITEMS).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Menu item ${index} must be an object.`);
    }

    const date = String(item.date || "");
    const text = String(item.text || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Menu item ${index} has an invalid date.`);
    }

    if (!text || text.length > 500) {
      throw new Error(`Menu item ${index} has invalid text.`);
    }

    return { date, day: formatWeekday(date), text };
  }).filter((item) => item.date >= currentDateString());
}

function buildMenuState(menuItems, options = {}) {
  const source = options.source || "Live";
  const pushedAt = options.pushedAt || new Date().toISOString();
  const dates = menuItems
    .map((item) => item.date)
    .filter(Boolean)
    .sort();
  return {
    title: "Dinnertime",
    source,
    items: menuItems,
    itemCount: menuItems.length,
    lastUpdated: currentDateString(),
    lastUpdatedTime: formatTime(pushedAt),
    updatedAt: pushedAt,
    pushedAt,
    latestMealDate: dates.length > 0 ? dates[dates.length - 1] : null
  };
}

function currentDateString() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MENU_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatWeekday(date) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

function formatTime(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MENU_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date(date));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}:${values.second}`;
}

module.exports = {
  buildMenuState,
  readSourceItems,
  validateMenuItems
};
