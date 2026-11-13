import type { SyncSource, SourceCursor } from "@splitin/spiderman-core";
import { ConnectorError } from "@splitin/spiderman-contracts";
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConnectorError("sync_response_invalid");
  return value as Record<string, any>;
};
const required = (value: unknown): string => {
  if (typeof value !== "string" || !value)
    throw new ConnectorError("sync_cursor_missing");
  return value;
};
export function googleSyncSources(): SyncSource[] {
  return [
    {
      name: "gmail.incoming",
      provider: "gmail",
      expiredCursorErrors: ["provider_http_404"],
      request(_resource, cursor) {
        return cursor?.historyId
          ? {
              operation: "mail.history",
              input: {
                startHistoryId: cursor.historyId,
                ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}),
                pageSize: 100,
              },
            }
          : { operation: "mail.profile", input: {} };
      },
      parse(raw, _resource, cursor) {
        const data = object(raw);
        if (!cursor?.historyId)
          return {
            cursor: { historyId: required(data.historyId) },
            events: [],
          };
        if (data.history !== undefined && !Array.isArray(data.history))
          throw new ConnectorError("sync_response_invalid");
        const events = (data.history ?? []).flatMap((history: any) =>
          (history.messagesAdded ?? [])
            .filter(
              (entry: any) =>
                !entry.message?.labelIds?.some((label: string) =>
                  ["SENT", "DRAFT"].includes(label),
                ),
            )
            .map((entry: any) => ({
              sourceId: "gmail.message:" + required(entry.message?.id),
              type: "mail.message_received",
              content: {
                messageId: entry.message.id,
                threadId: entry.message.threadId,
                historyId: history.id,
              },
            })),
        );
        const next: SourceCursor = data.nextPageToken
          ? {
              historyId: cursor.historyId,
              pageToken: required(data.nextPageToken),
            }
          : { historyId: required(data.historyId) };
        return { cursor: next, events, more: !!data.nextPageToken };
      },
    },
    {
      name: "calendar.changes",
      provider: "google-calendar",
      expiredCursorErrors: ["provider_http_410"],
      request(resource, cursor) {
        return {
          operation: "calendar.events",
          input: {
            calendarId: resource,
            pageSize: 100,
            ...(cursor?.syncToken ? { syncToken: cursor.syncToken } : {}),
            ...(cursor?.pageToken ? { pageToken: cursor.pageToken } : {}),
          },
        };
      },
      parse(raw, resource, cursor) {
        const data = object(raw);
        if (data.items !== undefined && !Array.isArray(data.items))
          throw new ConnectorError("sync_response_invalid");
        const bootstrapping = !cursor?.syncToken;
        // Initial discovery establishes a cursor, not an automatic personal-calendar replica.
        const events = bootstrapping
          ? []
          : (data.items ?? []).map((event: any) => ({
              sourceId:
                "calendar:" +
                resource +
                ":" +
                required(event.id) +
                ":" +
                required(event.etag ?? event.updated),
              type:
                event.status === "cancelled"
                  ? "calendar.event_cancelled"
                  : "calendar.event_changed",
              content: { calendarId: resource, event },
            }));
        const next: SourceCursor = data.nextPageToken
          ? {
              ...(cursor?.syncToken ? { syncToken: cursor.syncToken } : {}),
              pageToken: required(data.nextPageToken),
            }
          : { syncToken: required(data.nextSyncToken) };
        return { cursor: next, events, more: !!data.nextPageToken };
      },
    },
    {
      name: "drive.changes",
      provider: "google-drive",
      expiredCursorErrors: ["provider_http_410"],
      request(_resource, cursor) {
        return cursor?.pageToken
          ? {
              operation: "drive.changes",
              input: { pageToken: cursor.pageToken },
            }
          : { operation: "drive.startCursor", input: {} };
      },
      parse(raw, _resource, cursor) {
        const data = object(raw);
        if (!cursor)
          return {
            cursor: { pageToken: required(data.startPageToken) },
            events: [],
          };
        if (data.changes !== undefined && !Array.isArray(data.changes))
          throw new ConnectorError("sync_response_invalid");
        return {
          cursor: {
            pageToken: required(data.nextPageToken ?? data.newStartPageToken),
          },
          more: !!data.nextPageToken,
          events: (data.changes ?? []).map((change: any) => ({
            sourceId:
              "drive:" +
              required(change.fileId) +
              ":" +
              required(change.time) +
              ":" +
              (change.file?.version ?? "") +
              ":" +
              !!change.removed,
            type: change.removed ? "drive.file_removed" : "drive.file_changed",
            content: change,
          })),
        };
      },
    },
  ];
}
