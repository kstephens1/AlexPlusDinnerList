"use strict";

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
const MENU_BUCKET = process.env.MENU_BUCKET;
const MENU_KEY = process.env.MENU_KEY || "dinner-menu/items.json";
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
  if (isS3ObjectCreatedEvent(event)) {
    return handleS3ObjectCreated(event);
  }

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
    return speech("Dinnertime is ready.");
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
      shouldEndSession: true
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

async function handleS3ObjectCreated(event) {
  const records = Array.isArray(event.Records) ? event.Records : [];
  const changedKeys = records
    .map((record) => record && record.s3 && record.s3.object && record.s3.object.key)
    .filter(Boolean)
    .map((key) => decodeURIComponent(key.replace(/\+/g, " ")));

  console.log(JSON.stringify({
    eventType: "S3ObjectCreated",
    changedKeys
  }));

  if (!changedKeys.includes(MENU_KEY)) {
    return { ok: true, skipped: true };
  }

  const menuItems = await loadMenuItems();
  const targets = await loadTargets();
  let delivered = 0;

  for (const registeredTarget of targets) {
    if (!registeredTarget.apiEndpoint || !registeredTarget.target) {
      continue;
    }

    await sendDataStoreCommands(
      registeredTarget.apiEndpoint,
      registeredTarget.target,
      menuItems,
      "s3Sync"
    );
    delivered += 1;
  }

  console.log(JSON.stringify({
    s3SyncTargets: targets.length,
    s3SyncDelivered: delivered
  }));

  return { ok: true, delivered };
}

async function rememberAlexaTarget(event) {
  if (!MENU_BUCKET) {
    console.log("Skipping target registration: missing MENU_BUCKET");
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
        type: "PUT_OBJECT",
        namespace: DATA_NAMESPACE,
        key: STATE_KEY,
        content: state
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
        key: META_KEY,
        content: {
          title: state.title,
          itemCount: state.itemCount,
          lastUpdated: state.lastUpdated,
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
  if (!MENU_BUCKET) {
    return validateMenuItems(buildDefaultMenuItems());
  }

  try {
    const raw = await getObjectText(MENU_KEY);
    const parsed = JSON.parse(raw);
    return validateMenuItems(Array.isArray(parsed) ? parsed : parsed.items || parsed.dinnerList?.items);
  } catch (error) {
    console.log(JSON.stringify({
      menuLoadFailed: true,
      menuBucket: MENU_BUCKET,
      menuKey: MENU_KEY,
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
  if (!MENU_BUCKET) {
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
    Bucket: MENU_BUCKET,
    Key: key
  }));

  return response.Body.transformToString();
}

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: MENU_BUCKET,
    Key: key,
    Body: `${JSON.stringify(value, null, 2)}\n`,
    ContentType: "application/json"
  }));
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

function isS3ObjectCreatedEvent(event) {
  return Boolean(
    event &&
    Array.isArray(event.Records) &&
    event.Records.some((record) => record.eventSource === "aws:s3")
  );
}

function buildMenuState(menuItems) {
  const dates = menuItems
    .map((item) => item.date)
    .filter(Boolean)
    .sort();
  return {
    title: "Dinnertime",
    items: menuItems,
    itemCount: menuItems.length,
    lastUpdated: new Date().toISOString().slice(0, 10),
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
  validateMenuItems
};
