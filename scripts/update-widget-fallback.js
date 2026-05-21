"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildMenuState, readSourceItems, validateMenuItems } = require("./menu-utils");

const rootDir = path.join(__dirname, "..");
const menuPath = process.env.MENU_FILE || path.join(rootDir, "data", "dinner-menu-items.json");
const datasourcePath = path.join(
  rootDir,
  "skill-package",
  "dataStorePackages",
  "DinnertimeWidget",
  "datasources",
  "default.json"
);

const source = JSON.parse(fs.readFileSync(menuPath, "utf8"));
const items = validateMenuItems(readSourceItems(source));
const state = buildMenuState(items, { source: "Fallback" });

const datasource = {
  dinnerList: {
    title: state.title,
    source: state.source,
    emptyText: "No meals yet",
    items: state.items,
    lastUpdated: state.lastUpdated,
    lastUpdatedTime: state.lastUpdatedTime,
    updatedAt: state.updatedAt,
    pushedAt: state.pushedAt
  }
};

fs.writeFileSync(datasourcePath, `${JSON.stringify(datasource, null, 2)}\n`);
console.log(`Updated widget fallback with ${items.length} menu items.`);
