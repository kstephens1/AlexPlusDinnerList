"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildMenuState, readSourceItems, validateMenuItems } = require("./menu-utils");

const DATA_NAMESPACE = "Dinnertime";
const STATE_KEY = "state";
const ITEMS_KEY = "items";
const META_KEY = "meta";

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

async function main() {
  const rootDir = path.join(__dirname, "..");
  const menuPath = process.env.MENU_FILE || path.join(rootDir, "data", "dinner-menu-items.json");
  const targetsPath = process.env.TARGETS_FILE;
  const lambdaEnvPath = process.env.LAMBDA_ENV_FILE;

  const source = JSON.parse(fs.readFileSync(menuPath, "utf8"));
  const menuItems = validateMenuItems(readSourceItems(source));
  const state = buildMenuState(menuItems, { source: "Live" });
  const targets = loadTargets(targetsPath);

  if (targets.length === 0) {
    console.log("No registered Alexa Data Store targets found; first launch/install will seed from packaged JSON.");
    return;
  }

  const lambdaEnv = lambdaEnvPath
    ? JSON.parse(fs.readFileSync(lambdaEnvPath, "utf8")).Variables || {}
    : {};
  const clientId = process.env.ALEXA_SKILL_CLIENT_ID || lambdaEnv.ALEXA_SKILL_CLIENT_ID;
  const clientSecret = process.env.ALEXA_SKILL_CLIENT_SECRET || lambdaEnv.ALEXA_SKILL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("ALEXA_SKILL_CLIENT_ID and ALEXA_SKILL_CLIENT_SECRET are required.");
  }

  const token = await getLwaToken(clientId, clientSecret);
  let delivered = 0;

  for (const registeredTarget of targets) {
    if (!registeredTarget.apiEndpoint || !registeredTarget.target) {
      continue;
    }

    const result = await sendDataStoreCommands(
      registeredTarget.apiEndpoint,
      registeredTarget.target,
      menuItems,
      state
    );
    if (result.delivered) {
      delivered += 1;
    }
  }

  console.log(`Direct Data Store push complete: ${delivered}/${targets.length} targets accepted.`);

  async function sendDataStoreCommands(apiEndpoint, target, items, menuState) {
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
          content: items
        },
        {
          type: "PUT_OBJECT",
          namespace: DATA_NAMESPACE,
          key: STATE_KEY,
          content: menuState
        },
        {
          type: "PUT_OBJECT",
          namespace: DATA_NAMESPACE,
          key: META_KEY,
          content: {
            title: menuState.title,
            itemCount: menuState.itemCount,
            source: menuState.source,
            lastUpdated: menuState.lastUpdated,
            lastUpdatedTime: menuState.lastUpdatedTime,
            updatedAt: menuState.updatedAt,
            pushedAt: menuState.pushedAt,
            latestMealDate: menuState.latestMealDate
          }
        }
      ],
      target,
      attemptDeliveryUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    };

    const response = await fetch(`${apiEndpoint}/v1/datastore/commands`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const responseBody = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(responseBody);
    } catch (error) {
      // Keep non-JSON errors visible in the log below.
    }
    const resultTypes = parsed && Array.isArray(parsed.results)
      ? parsed.results.map((item) => item.type)
      : [];
    const delivered = response.ok && resultTypes.length > 0 && resultTypes.every((type) => type === "SUCCESS");

    console.log(JSON.stringify({
      apiEndpoint,
      target,
      status: response.status,
      ok: response.ok,
      delivered,
      resultTypes,
      firstMenuItem: items[0],
      body: responseBody
    }));

    return { delivered };
  }
}

function loadTargets(targetsPath) {
  if (!targetsPath || !fs.existsSync(targetsPath)) {
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

async function getLwaToken(clientId, clientSecret) {
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
    throw new Error(`LWA token request failed: ${response.status} ${responseBody}`);
  }

  return JSON.parse(responseBody).access_token;
}
