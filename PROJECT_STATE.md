# Project State

## What Changed

- Updated the Dinnertime Alexa widget package from `1.0.15` to `1.0.19`.
- Kept the stale-data fix: widget rows render from Alexa Data Store key `Dinnertime/items` first, then `Dinnertime/state`, then packaged fallback data.
- Updated the widget footer version text to `v1.0.19`.
- Updated the local dinner menu data for the week starting 2026-06-24.
- Regenerated the widget fallback datasource from the local menu data. Because the current date is 2026-06-26, fallback data now starts at 2026-06-26 after past-date filtering.
- Updated docs to describe the current Data Store contract:
  - `Dinnertime/items` is the authoritative visible row source.
  - `Dinnertime/meta` carries footer timestamp/summary metadata.
  - `Dinnertime/state` remains a combined compatibility object.
- Added README guidance that normal meal-only changes should use `./scripts/push-menu.sh`, while full widget/Lambda/skill changes should use `./scripts/deploy.sh`.

## Files Touched

- `PROJECT_STATE.md`
- `README.md`
- `DEPLOYMENT.md`
- `data/dinner-menu-items.json`
- `skill-package/dataStorePackages/DinnertimeWidget/datasources/default.json`
- `skill-package/dataStorePackages/DinnertimeWidget/documents/document.json`
- `skill-package/dataStorePackages/DinnertimeWidget/manifest.json`

## Current Working State

- Local widget package JSON validates.
- Lambda syntax and tests pass.
- Alexa Data Store menu push succeeded for both registered device targets.
- ASK skill metadata import for the final package version succeeded.
- Exported Alexa development package confirms:
  - `DinnertimeWidget` version is `1.0.19`.
  - Widget document footer shows `v1.0.19`.
  - Widget row binding uses `Dinnertime/items` first.
- `ask smapi get-skill-status` still shows an older stale `INVALID_DATASTORE_PACKAGE_MANIFEST` summary for a prior failed import, but direct import status for the latest successful import is `SUCCEEDED` and exported package contents match local `1.0.19`.

## Known Bugs

- Alexa device/gallery caching can lag after a widget package deploy. If the device still says "Unable to get widget", wait briefly and retry installing the widget.
- The ASK `get-skill-status` response appears stale for this skill after package import retries; use `ask smapi get-import-status --import-id <latest import id>` and package export as the more reliable verification path.
- Widget install/open behavior still depends on the Echo Show receiving the package update and lifecycle event. If installation remains stuck after cache propagation, remove/re-add the development skill/widget or open `Dinnertime` once to refresh registration and seeding.

## Next Recommended Task

Test installation on the Echo Show again and confirm the installed widget displays `v1.0.19` with the 2026-06-26 menu row first. If install still fails, capture the exact time and device, then query ASK/Alexa logs around that time and consider bumping to a new package ID to bypass any stuck device-side cache.

## Commands Run And Results

- `node -e "JSON.parse(...)"` over widget package JSON and skill manifest:
  - Result: JSON parsed successfully.
- `npm test` in `lambda/`:
  - Result: passed, 4/4 tests.
- `node scripts/update-widget-fallback.js`:
  - Result: regenerated fallback datasource from local menu data.
- `./scripts/deploy.sh`:
  - First final-data deploy accepted Data Store pushes for 2/2 targets and deployed package `1.0.17`, but later ASK status showed `INVALID_DATASTORE_PACKAGE_MANIFEST`.
  - A bad diagnostic attempt adding root `type: "APL_PACKAGE"` failed with `$.type: is not defined in the schema`.
  - A bad diagnostic attempt adding `manifest.type` failed with `$.manifest.type: is not defined in the schema`.
  - Final clean-shape package deploy with version `1.0.19` succeeded.
- `ask smapi get-skill-status --skill-id amzn1.ask.skill.3001f4de-4506-4451-bf66-c53e1f8871fa --profile default`:
  - Result: showed stale failure from an older import: `INVALID_DATASTORE_PACKAGE_MANIFEST`.
- `ask smapi export-package --skill-id amzn1.ask.skill.3001f4de-4506-4451-bf66-c53e1f8871fa --stage development --profile default`:
  - Result: exported package contained `DinnertimeWidget` `1.0.19` and the fixed document binding.
- `ask smapi get-import-status --import-id amzn1.ask-package.import.9f518317-4e29-4504-af3b-9da2f28c9d47 --profile default`:
  - Result: `SUCCEEDED`.
