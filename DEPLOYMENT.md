# Deployment

This project uses the Amazon-recommended widget pattern:

- The Echo Show widget is an APL package under `skill-package/dataStorePackages/DinnertimeWidget`.
- The widget reads live dinner menu state from the on-device Alexa Data Store at namespace `Dinnertime`, key `state`.
- The editable source of truth is a private S3 JSON object, defaulting to `dinner-menu/items.json`.
- Each source record has `date` as `YYYY-MM-DD` and `text` as the meal text, maximum 500 characters.
- Lambda adds display fields such as `day` and writes one state object to Alexa Data Store.
- The Lambda backend handles skill requests and widget lifecycle events.
- S3 object-created events trigger Lambda, and Lambda syncs the changed menu into Alexa Data Store for registered widget targets.
- `scripts/deploy.sh` automates S3 bucket setup, Lambda packaging, IAM role creation, Lambda create/update, S3 event wiring, endpoint wiring, and optional ASK CLI skill-package deployment.

## One-time local setup

1. Install the AWS CLI and authenticate it:

   ```bash
   aws configure --profile default
   ```

2. Install and configure the ASK CLI:

   ```bash
   npm install -g ask-cli
   ask configure --profile default
   ```

3. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

4. Edit `.env` if needed. Keep `DEPLOY_SKILL=0` for the first run unless you already have ASK CLI fully configured for this project.

## First deployment

Run:

```bash
./scripts/deploy.sh
```

The script will:

- run a syntax check on `lambda/index.js`
- build `build/lambda.zip`
- create or reuse the private S3 menu bucket
- create or update the Lambda execution role
- grant Lambda scoped access to the menu and target registry objects
- create or update the Lambda function
- configure the S3 object-created trigger for `dinner-menu/items.json`
- write the real Lambda ARN into `skill-package/skill.json`

## Create or deploy the Alexa skill

After the Lambda exists, deploy the skill package:

```bash
DEPLOY_SKILL=1 ./scripts/deploy.sh
```

If ASK CLI creates a new skill, get its ID:

```bash
ask smapi list-skills --profile default
```

Find `Dinnertime`, then add the skill ID to `.env`:

```bash
ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
DEPLOY_SKILL=1
```

Run the deployment again:

```bash
./scripts/deploy.sh
```

That final run adds the Lambda invoke permission for the specific Alexa skill and redeploys the skill package with `ask deploy --target skill-metadata`.

## Manual Alexa console steps

Some widget tasks are still best verified in the Alexa Developer Console.

1. Open <https://developer.amazon.com/alexa/console/ask>.
2. Open the `Dinnertime` skill.
3. Go to **Build**.
4. Confirm these interfaces are enabled:
   - `Alexa.DataStore.PackageManager`
   - `Alexa.DataStore`
   - `Alexa Presentation Language`
   - APL Data Store Extension `alexaext:datastore:10`
5. Go to **Multimodal Responses** -> **Widget**.
6. Confirm `DinnertimeWidget` appears.
7. Open the widget and verify the package manifest, document, and preview render.
8. Use the widget authoring tool's Data Store tab to test this command:

   ```json
   [
     {
       "type": "PUT_OBJECT",
       "namespace": "DinnerList",
       "key": "items",
       "content": [
         {
           "date": "2026-04-28",
           "text": "meal 1"
         },
         {
           "date": "2026-04-27",
           "text": "meal 2"
         },
         {
           "date": "2026-04-26",
           "text": "meal 3"
         },
         {
           "date": "2026-04-25",
           "text": "meal 4"
         },
         {
           "date": "2026-04-24",
           "text": "meal 5"
         }
       ]
     }
   ]
   ```

9. On the Echo Show 15, install the widget from the Widget Gallery for the development-stage skill.
10. Verify the widget appears on the home screen / widget panel.

The widget is intentionally read-only. Dinner menu edits should happen in the external iPhone app or backend, then sync into Alexa Data Store.

For manual testing, update the menu file directly:

```bash
aws s3 cp data/dinner-menu-items.json s3://<bucket>/dinner-menu/items.json --content-type application/json
```

The deployed S3 trigger invokes Lambda after that upload. Lambda reads the file, validates up to 50 records, and pushes them to Alexa Data Store for targets registered by prior widget install/open events.

During development, remove and re-add the widget after deployment to trigger `Alexa.DataStore.PackageManager.UsagesInstalled`. That lifecycle event seeds the five fallback records into the current device's Alexa Data Store.

## Subsequent deployments

For code, skill package, or widget changes:

```bash
./scripts/deploy.sh
```

The script updates Lambda and, when `DEPLOY_SKILL=1`, runs `ask deploy --target skill-metadata`.

## Before certification

Replace the placeholder `iconUri` and `previews` values in `skill-package/dataStorePackages/DinnertimeWidget/manifest.json` with HTTPS URLs for your production icon and widget preview images. The default Amazon placeholder URLs are enough for local scaffolding but should not be used for a published skill.

## Data Update Flow

The script now uses S3 as the low-cost source of truth:

```text
s3://<bucket>/dinner-menu/items.json
```

The Lambda stores widget targets in:

```text
s3://<bucket>/dinner-menu/targets.json
```

The target registry is populated when the skill receives `LaunchRequest`, `Alexa.DataStore.PackageManager.UsagesInstalled`, or `Alexa.DataStore.PackageManager.UpdateRequest`. If you update the menu before the Echo Show has opened/installed the current deployment at least once, there may be no registered target to push to yet. Open `Dinnertime` or remove/re-add the widget once, then upload the menu JSON again.

Use `Alexa, open dinnertime` when testing the skill by voice. This project includes `en-US` and `en-GB` interaction models; make sure the simulator/device locale is one of those locales.
