# Changelog

Notable application and Worker changes are recorded here. Worker versions describe the Worker source; actual production deployments are recorded separately in `DEPLOYMENTS.md`.

## [Unreleased]

### Security

- Escape server-provided values in the home plan list, company filter, and plan detail view.
- Escape existing plan, company, and manager values rendered in the plan edit form.
- Escape user identity and company values rendered in the header, registration, my-page, and pending-user approval views.
- Replace plan-ID inline event handlers in those views with programmatically bound listeners.
- Replace plan-ID inline save handlers in the edit form with programmatically bound listeners.
- Replace pending-user email inline approval handlers with index-based bound listeners.
- Restrict plan status CSS classes to known status values.

## [1.4.1] - 2026-10-02

### Fixed

- Centralized account-status classification so login and protected APIs apply the same approval rule.
- Reject missing, malformed, or role-like account status values instead of reporting a successful login that later receives API 403 responses.

### Compatibility

- No API endpoint or stored field was removed.
- Valid `pending`, `rejected`, `suspended`, and `approved` behavior is preserved.
- Existing records with values such as `status: "hyundai"` require a read-only audit and explicit correction after their real approval state is confirmed; the Worker does not auto-approve them.

## [1.4.0] - 2026-10-01

### Added

- Defined vendor, Hyundai, and Hyundai ADMIN authorization tiers.
- Applied server-side restrictions for plan creation, editing, submission, approval, rejection, and deletion.

### Fixed

- Rejected unsafe plan IDs that could manipulate GitHub data paths.
- Prevented clients from overwriting server-managed plan fields.
- Restored simultaneous user name and phone updates.

## [1.3.0] - 2026-09-30

### Changed

- Allowed Hyundai users to delete draft and pending plans while retaining the approved-plan deletion restriction.

## [1.2.0] - 2026-09-29

### Added

- Added `scope=all` and `company` plan-list filters while retaining role-based defaults.

## [1.1.0] - 2026-09-29

### Fixed

- Ensured ADMIN accounts receive the full plan list regardless of their stored company.
- Made company renaming safer and repeatable by updating plans before user records.
