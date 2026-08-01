---
type: is
id: is-01kyxzhsbtmjbh50fa85prscvp
title: "PR #1 review I8d: retain parsed supported marker identity values"
kind: task
status: closed
priority: 4
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:17:58.905Z
updated_at: 2026-08-01T06:28:36.395Z
closed_at: 2026-08-01T06:28:36.394Z
close_reason: "Rebutted for f1.0: recognizeStore first validates that format and format_version equal the exact only-supported literals before constructing StoreMarker, so returning those typed literals loses no information. A future minor-version compatibility implementation must widen the type and return the parsed compatible value as part of that feature."
---
Owner engineering review I8d. recognizeStore validates parsed marker fields then returns hardcoded STORE_FORMAT_NAME and STORE_FORMAT_VERSION (packages/fsqlite/src/storeFormat.ts:127-134). Today exact support makes them equivalent, but returning validated parsed values avoids discarding information needed for future minor compatibility; add a compatibility-oriented test when the model is chosen.
