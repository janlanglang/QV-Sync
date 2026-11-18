# Change Log

All notable changes to the "erp-dashboard-sync" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- No changes yet.

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