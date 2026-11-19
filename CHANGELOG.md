# Change Log

All notable changes to the "erp-dashboard-sync" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- No changes yet.

## [1.1.0] - 2026-11-19

- Rename managed Query and Dashboard files on reload when their ERP names change, using GUIDs to preserve their identity.

## [1.0.0] - 2026-11-18

- Bundle a Copilot Chat skill with detailed Quickview, Flow, ERP sync, data-service, documentation, and anonymized example references for safely editing materialized files.

## [0.3.9] - 2026-11-18

- Materialize `QVQUERY.OPTIONS` as an unchanged `.options.xml` file and synchronize edits with the existing query versioning; existing indexes remain supported before reload.
- Check and update the parent `QVDASHBOARD.ANP_VERSION` for dashboard-query changes; retain pending synchronization on partial failure and prevent writes when version selection is cancelled.

## [0.3.8] - 2026-11-18

- Materialize `QVDASHBOARDQUERY.PARAMSTRING`, `JSCHARTSCRIPT` and `CHARTOPTIONS` as separate assignment-GUID-based files and upload edits to the correct assignment row.
- Preserve existing project/index support before reload; additional files are optional until materialized. Include indexed TXT files in filesystem sync.
- Preserve carriage returns in SOAP content updates and provide a consistently German README.

## [0.3.7] - 2026-11-18

- Detect external changes to indexed JS/CSS/SQL/XML files in addition to editor saves, independent of editor language mode.
- Serialize uploads and reloads, debounce file events, and persist content hashes to avoid duplicate uploads and reload feedback loops.
- Support nested dashboard folders and multi-root workspaces while reusing existing local configurations, indexes and folder-scoped credentials.
- Add dashboard selection for commands, reload-all, per-context startup reload and resource-scoped VS Code settings.

## [0.3.5] - 2026-07-21

- Updated extension icon file.

## [0.2.0] - 2026-07-01

- Added support for dashboard version handling via `ANP_VERSION`.
- Save sync now updates content and version together (`VERSION` for queries, `ANP_VERSION` for dashboards) using format `YYYYMMDD`.
- Added startup reload for already linked dashboards with optional confirmation prompt.
- Fixed fallback behavior for ERP systems without `ANP_VERSION` by retrying SQL without that field.
- Updated README with versioning, fallback and startup auto-reload documentation.