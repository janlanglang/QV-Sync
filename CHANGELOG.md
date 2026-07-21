# Change Log

All notable changes to the "erp-dashboard-sync" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- No changes yet.

## [0.3.5] - 2026-07-21

- Updated extension icon file.

## [0.2.0] - 2026-07-01

- Added support for dashboard version handling via `ANP_VERSION`.
- Save sync now updates content and version together (`VERSION` for queries, `ANP_VERSION` for dashboards) using format `YYYYMMDD`.
- Added startup reload for already linked dashboards with optional confirmation prompt.
- Fixed fallback behavior for ERP systems without `ANP_VERSION` by retrying SQL without that field.
- Updated README with versioning, fallback and startup auto-reload documentation.