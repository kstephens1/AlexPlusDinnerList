"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { _private } = require("./index");

function offsetDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

test("validateMenuItems removes past meals while keeping today and future meals", () => {
  const today = _private.currentDateString();
  const yesterday = offsetDate(today, -1);
  const tomorrow = offsetDate(today, 1);

  const items = _private.validateMenuItems([
    { date: yesterday, text: "Yesterday's dinner" },
    { date: today, text: "Today's dinner" },
    { date: tomorrow, text: "Tomorrow's dinner" }
  ]);

  assert.deepEqual(items.map((item) => item.date), [today, tomorrow]);
  assert.equal(items[0].day.length, 3);
});

test("default fallback meals start today so they survive filtering", () => {
  const today = _private.currentDateString();
  const fallbackItems = _private.validateMenuItems(_private.buildDefaultMenuItems());

  assert.equal(fallbackItems.length, 5);
  assert.equal(fallbackItems[0].date, today);
  assert.ok(fallbackItems.every((item) => item.date >= today));
});

test("buildMenuState reflects the filtered meal list", () => {
  const today = _private.currentDateString();
  const tomorrow = offsetDate(today, 1);
  const items = _private.validateMenuItems([
    { date: offsetDate(today, -1), text: "Past meal" },
    { date: tomorrow, text: "Future meal" }
  ]);
  const state = _private.buildMenuState(items);

  assert.equal(state.itemCount, 1);
  assert.equal(state.latestMealDate, tomorrow);
  assert.deepEqual(state.items.map((item) => item.text), ["Future meal"]);
});
