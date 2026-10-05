# Activity logging tools

## Capabilities

- Get individual calls, notes, and external SMS communications.
- Update allowlisted call/note fields with a pre-read and property readback.
- Read contact, company, or deal associations using bounded v4 pagination.
- Log external SMS activities; these tools never send text messages.

Call update fields cover title, body, direction, duration in milliseconds, disposition, status, timestamp, and owner. Note update fields cover body, timestamp, owner, and attachment IDs. Timestamps cannot be cleared. Original timestamps and intended call statuses must be supplied explicitly by callers; do not silently default historical calls to `QUEUED`.

Writes disable automatic rate-limit retries. Uncertain outcomes preserve known IDs and correlation data for reconciliation; callers must not retry blindly. `recovered` means that a read proved the requested final state after the write path failed, not that the failed request necessarily committed.

SMS creation checks existing contact-associated communications for matching body, channel, and timestamp. This is best-effort deduplication, **not guaranteed idempotency or concurrent-create safety**. Verification exposes contact, company, and deal associations, including extras; it does not delete them.

Association reads use `/crm/v4/objects/{from}/{id}/associations/{to}` and dynamic labels use `/crm/v4/associations/{from}/{to}/labels`. Pagination is limited to 20 pages of 500 links and fails closed on malformed pages, cycles, or overflow. Communications use the existing plural CRM object route.

## Limitations and rollout

- Tests mock HubSpot requests. Live account permissions, timeline rendering, default association labels, and eventual consistency require separate sandbox validation before production rollout.
- Existing generic call/note create tools are unchanged; they do not gain the new guarded update behavior.
- Some definite write rejections conservatively return an uncertain status.
- Duplicate checks can be slow for contacts with many communications and cannot prevent races.
- This change does not include a collector, scheduler, automatic CRM writes, or historical-record corrections.

## Verification

`npm test`: 150 tests across nine files. `npm run typecheck` and `npm run build`: pass. Tests include an in-memory MCP client/server check of registration and actual input-schema behavior. OAuth tests use a temporary local listener. Fixtures are synthetic; no customer conversation data is included.
