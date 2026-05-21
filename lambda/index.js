"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} = require("@aws-sdk/client-s3");

const DATA_NAMESPACE = "Dinnertime";
const STATE_KEY = "state";
const ITEMS_KEY = "items";
const META_KEY = "meta";
const MAX_MENU_ITEMS = 50;
const FULLSCREEN_TOKEN = "dinnertime-fullscreen";
const FULLSCREEN_TIMEOUT_MS = 15000;
const TARGETS_BUCKET = process.env.TARGETS_BUCKET || process.env.MENU_BUCKET;
const TARGETS_KEY = process.env.TARGETS_KEY || "dinner-menu/targets.json";
const MENU_TIME_ZONE = process.env.MENU_TIME_ZONE || "Europe/London";
const s3 = new S3Client({});
let cachedLwaToken;
let cachedLwaTokenExpiresAt = 0;

const DEFAULT_MENU_TEXTS = [
  "Pasta bake with garlic bread",
  "Chicken stir fry with rice",
  "Mini toad in the hole with broccoli",
  "Meatballs with tomato sauce",
  "Roast chicken with vegetables"
];

exports.handler = async function handler(event) {
  console.log(JSON.stringify({
    requestType: event && event.request && event.request.type,
    requestId: event && event.request && event.request.requestId,
    packageId: event && event.request && (event.request.packageId || event.request.payload?.packageId),
    packageVersion: event && event.request && (event.request.packageVersion || event.request.payload?.packageVersion),
    fromVersion: event && event.request && event.request.fromVersion,
    toVersion: event && event.request && event.request.toVersion,
    installedPackages: event && event.context && event.context["Alexa.DataStore.PackageManager"]
      ? event.context["Alexa.DataStore.PackageManager"].installedPackages
      : undefined
  }));

  const request = event.request || {};

  if (request.type === "LaunchRequest") {
    await rememberAlexaTarget(event);
    await seedDeviceDataStore(event);
    const menuItems = await loadMenuItems();
    return fullScreenMenuResponse(menuItems, todayMealSpeech(menuItems));
  }

  if (request.type === "Alexa.Presentation.APL.UserEvent") {
    await rememberAlexaTarget(event);
    await seedDeviceDataStore(event);
    const menuItems = await loadMenuItems();
    return fullScreenMenuResponse(menuItems, todayMealSpeech(menuItems));
  }

  if (request.type === "Alexa.DataStore.PackageManager.UsagesInstalled") {
    await rememberAlexaTarget(event);
    await seedDeviceDataStore(event);
    return emptyResponse();
  }

  if (request.type === "Alexa.DataStore.PackageManager.UpdateRequest") {
    await rememberAlexaTarget(event);
    await seedDeviceDataStore(event);
    return emptyResponse();
  }

  if (request.type === "Alexa.DataStore.PackageManager.UsagesRemoved") {
    return emptyResponse();
  }

  if (request.type === "Alexa.DataStore.CommandsResponse") {
    console.log("Data store command response", JSON.stringify(request));
    return emptyResponse();
  }

  if (request.type === "IntentRequest") {
    const intentName = request.intent && request.intent.name;

    if (intentName === "AMAZON.HelpIntent") {
      return speech("You can add the Dinnertime widget to your Echo Show home screen.");
    }

    if (intentName === "AMAZON.CancelIntent" || intentName === "AMAZON.StopIntent") {
      return speech("Goodbye.");
    }
  }

  return speech("Dinnertime is ready.");
};

function speech(text) {
  return {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text
      },
      shouldEndSession: false
    }
  };
}

function fullScreenMenuResponse(menuItems, text) {
  const state = buildMenuState(menuItems);
  return {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text
      },
      directives: [
        {
          type: "Alexa.Presentation.APL.RenderDocument",
          token: FULLSCREEN_TOKEN,
          document: buildFullScreenDocument(),
          datasources: {
            dinnerList: state
          }
        }
      ],
      shouldEndSession: true
    }
  };
}

function todayMealSpeech(menuItems) {
  const today = currentDateString();
  const todayItem = menuItems.find((item) => item.date === today);

  if (!todayItem) {
    return "There is no meal listed for today.";
  }

  return `Today's meal is ${todayItem.text}.`;
}

function buildFullScreenDocument() {
  return {
    type: "APL",
    version: "2024.3",
    theme: "dark",
    settings: {
      idleTimeout: FULLSCREEN_TIMEOUT_MS
    },
    mainTemplate: {
      parameters: ["dinnerList"],
      items: [
        {
          type: "Container",
          width: "100vw",
          height: "100vh",
          paddingLeft: 56,
          paddingRight: 56,
          paddingTop: 38,
          paddingBottom: 28,
          backgroundColor: "#17202A",
          items: [
            {
              type: "Text",
              text: "${dinnerList.title}",
              fontSize: 44,
              fontWeight: "700",
              color: "#FFFFFF",
              maxLines: 1
            },
            {
              type: "Sequence",
              height: "76vh",
              paddingTop: 20,
              scrollDirection: "vertical",
              data: "${dinnerList.items}",
              items: [
                {
                  type: "Container",
                  minHeight: 72,
                  paddingTop: 10,
                  paddingBottom: 10,
                  direction: "row",
                  alignItems: "start",
                  items: [
                    {
                      type: "Frame",
                      width: 12,
                      height: 12,
                      borderRadius: 6,
                      backgroundColor: "#58D68D",
                      marginTop: 12
                    },
                    {
                      type: "Text",
                      width: 72,
                      paddingLeft: 16,
                      text: "${data.day}",
                      fontSize: 22,
                      fontWeight: "700",
                      color: "#D5DBDB",
                      maxLines: 1,
                      paddingTop: 2
                    },
                    {
                      type: "Text",
                      paddingLeft: 10,
                      width: 0,
                      grow: 1,
                      shrink: 1,
                      text: "${data.text}",
                      fontSize: 28,
                      fontWeight: "600",
                      color: "#FFFFFF"
                    }
                  ]
                }
              ]
            },
            {
              type: "Text",
              text: "Live - Updated ${dinnerList.lastUpdated} ${dinnerList.lastUpdatedTime}",
              fontSize: 20,
              color: "#AAB7B8",
              textAlign: "right",
              maxLines: 1
            }
          ]
        }
      ]
    }
  };
}

function emptyResponse() {
  return {
    version: "1.0",
    response: {}
  };
}

async function seedDeviceDataStore(event) {
  const system = event && event.context && event.context.System;
  const apiEndpoint = system && system.apiEndpoint;
  const deviceId = system && system.device && system.device.deviceId;
  const userId = system && system.user && system.user.userId;

  if (!apiEndpoint) {
    console.log("Skipping Data Store seed: missing apiEndpoint");
    return;
  }

  const target = deviceId
    ? { type: "DEVICES", items: [deviceId] }
    : { type: "USER", id: userId };

  if (!deviceId && !userId) {
    console.log("Skipping Data Store seed: missing deviceId and userId");
    return;
  }

  const menuItems = await loadMenuItems();
  await sendDataStoreCommands(apiEndpoint, target, menuItems, "seed");
}

async function rememberAlexaTarget(event) {
  if (!TARGETS_BUCKET) {
    console.log("Skipping target registration: missing TARGETS_BUCKET");
    return;
  }

  const system = event && event.context && event.context.System;
  const apiEndpoint = system && system.apiEndpoint;
  const deviceId = system && system.device && system.device.deviceId;
  const userId = system && system.user && system.user.userId;

  if (!apiEndpoint || (!deviceId && !userId)) {
    console.log("Skipping target registration: missing apiEndpoint/deviceId/userId");
    return;
  }

  const id = [userId || "unknown-user", deviceId || "user-target"].join("#");
  const target = deviceId
    ? { type: "DEVICES", items: [deviceId] }
    : { type: "USER", id: userId };
  const targets = await loadTargets();
  const nextTarget = {
    id,
    apiEndpoint,
    target,
    userId,
    deviceId,
    lastSeen: new Date().toISOString()
  };
  const existingIndex = targets.findIndex((item) => item.id === id);

  if (existingIndex >= 0) {
    targets[existingIndex] = nextTarget;
  } else {
    targets.push(nextTarget);
  }

  await putJson(TARGETS_KEY, targets);
  console.log(JSON.stringify({
    targetRegistered: id,
    targetCount: targets.length
  }));
}

async function sendDataStoreCommands(apiEndpoint, target, menuItems, reason) {
  const state = buildMenuState(menuItems);
  const body = {
    commands: [
      {
        type: "PURGE_OBJECTS",
        namespace: DATA_NAMESPACE
      },
      {
        type: "PUT_OBJECT",
        namespace: DATA_NAMESPACE,
        key: ITEMS_KEY,
        content: menuItems
      },
      {
        type: "PUT_OBJECT",
        namespace: DATA_NAMESPACE,
        key: STATE_KEY,
        content: state
      },
      {
        type: "PUT_OBJECT",
        namespace: DATA_NAMESPACE,
        key: META_KEY,
        content: {
          title: state.title,
          itemCount: state.itemCount,
          source: state.source,
          lastUpdated: state.lastUpdated,
          lastUpdatedTime: state.lastUpdatedTime,
          updatedAt: state.updatedAt,
          pushedAt: state.pushedAt,
          latestMealDate: state.latestMealDate
        }
      },
    ],
    target,
    attemptDeliveryUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  };

  const lwaToken = await getLwaToken();
  if (!lwaToken) {
    console.log("Skipping Data Store update: missing LWA token");
    return;
  }

  const response = await fetch(`${apiEndpoint}/v1/datastore/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lwaToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.text();
  let parsedResponseBody = null;
  try {
    parsedResponseBody = JSON.parse(responseBody);
  } catch (error) {
    // Keep the raw response in the log below when Alexa returns non-JSON errors.
  }
  const resultTypes = parsedResponseBody && Array.isArray(parsedResponseBody.results)
    ? parsedResponseBody.results.map((result) => result.type)
    : [];
  const deliveredToAllTargets = resultTypes.length > 0 && resultTypes.every((type) => type === "SUCCESS");
  console.log(JSON.stringify({
    dataStoreUpdateReason: reason,
    dataStoreNamespace: DATA_NAMESPACE,
    dataStoreKeys: [ITEMS_KEY, META_KEY, STATE_KEY],
    firstMenuItem: menuItems[0],
    lastUpdated: state.lastUpdated,
    dataStoreUpdateStatus: response.status,
    dataStoreUpdateOk: response.ok,
    dataStoreUpdateDelivered: deliveredToAllTargets,
    dataStoreUpdateResultTypes: resultTypes,
    dataStoreUpdateBody: responseBody
  }));
}

async function loadMenuItems() {
  try {
    const raw = fs.readFileSync(findMenuFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return validateMenuItems(Array.isArray(parsed) ? parsed : parsed.items || parsed.dinnerList?.items);
  } catch (error) {
    console.log(JSON.stringify({
      menuLoadFailed: true,
      errorName: error.name,
      errorMessage: error.message
    }));
    return validateMenuItems(buildDefaultMenuItems());
  }
}

function buildDefaultMenuItems() {
  const today = currentDateString();
  return DEFAULT_MENU_TEXTS.map((text, index) => ({
    date: addDays(today, index),
    text
  }));
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function loadTargets() {
  if (!TARGETS_BUCKET) {
    return [];
  }

  try {
    const raw = await getObjectText(TARGETS_KEY);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.name !== "NoSuchKey") {
      console.log(JSON.stringify({
        targetsLoadFailed: true,
        targetsKey: TARGETS_KEY,
        errorName: error.name,
        errorMessage: error.message
      }));
    }
    return [];
  }
}

async function getObjectText(key) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: TARGETS_BUCKET,
    Key: key
  }));

  return response.Body.transformToString();
}

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: TARGETS_BUCKET,
    Key: key,
    Body: `${JSON.stringify(value, null, 2)}\n`,
    ContentType: "application/json"
  }));
}

function findMenuFilePath() {
  const candidates = [
    path.join(__dirname, "data", "dinner-menu-items.json"),
    path.join(__dirname, "..", "data", "dinner-menu-items.json")
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Packaged dinner-menu-items.json was not found.");
  }
  return found;
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
  }).filter((item) => !isPastMealDate(item.date));
}

function buildMenuState(menuItems) {
  const pushedAt = new Date().toISOString();
  const dates = menuItems
    .map((item) => item.date)
    .filter(Boolean)
    .sort();
  return {
    title: "Dinnertime",
    source: "Live",
    items: menuItems,
    itemCount: menuItems.length,
    lastUpdated: new Date().toISOString().slice(0, 10),
    lastUpdatedTime: formatTime(pushedAt),
    updatedAt: pushedAt,
    pushedAt,
    latestMealDate: dates.length > 0 ? dates[dates.length - 1] : null
  };
}

function isPastMealDate(date) {
  return date < currentDateString();
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

async function getLwaToken() {
  if (cachedLwaToken && Date.now() < cachedLwaTokenExpiresAt) {
    return cachedLwaToken;
  }

  const clientId = process.env.ALEXA_SKILL_CLIENT_ID;
  const clientSecret = process.env.ALEXA_SKILL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log("Missing ALEXA_SKILL_CLIENT_ID or ALEXA_SKILL_CLIENT_SECRET");
    return null;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "alexa::datastore"
  });

  const response = await fetch("https://api.amazon.com/auth/O2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const responseBody = await response.text();
  if (!response.ok) {
    console.log(JSON.stringify({
      lwaTokenStatus: response.status,
      lwaTokenOk: response.ok,
      lwaTokenBody: responseBody
    }));
    return null;
  }

  const token = JSON.parse(responseBody);
  cachedLwaToken = token.access_token;
  cachedLwaTokenExpiresAt = Date.now() + Math.max((token.expires_in || 3600) - 60, 60) * 1000;
  return cachedLwaToken;
}

exports.DATA_STORE_LOCATION = {
  namespace: DATA_NAMESPACE,
  itemsKey: ITEMS_KEY,
  metaKey: META_KEY,
  stateKey: STATE_KEY
};

exports._private = {
  buildDefaultMenuItems,
  buildMenuState,
  currentDateString,
  isPastMealDate,
  todayMealSpeech,
  validateMenuItems
};
