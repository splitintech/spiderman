import type { SyncSource } from "@splitin/spiderman-core";
import { ConnectorError } from "@splitin/spiderman-contracts";
export function imapSyncSource(): SyncSource {
  return {
    name: "imap.incoming",
    provider: "imap-smtp",
    expiredCursorErrors: ["imap_cursor_invalid"],
    request(resource, cursor) {
      return {
        operation: "mail.changes",
        input: {
          folder: resource,
          ...(cursor
            ? { uidValidity: cursor.uidValidity, afterUid: cursor.lastUid }
            : {}),
        },
      };
    },
    parse(raw, resource) {
      const data = raw as {
        uidValidity: string;
        lastUid: number;
        messages: { uid: number }[];
        more?: boolean;
      };
      if (
        typeof data.uidValidity !== "string" ||
        !Number.isSafeInteger(data.lastUid) ||
        !Array.isArray(data.messages)
      )
        throw new ConnectorError("sync_response_invalid");
      return {
        cursor: { uidValidity: data.uidValidity, lastUid: data.lastUid },
        events: data.messages.map((message) => ({
          sourceId:
            "imap:" + resource + ":" + data.uidValidity + ":" + message.uid,
          type: "mail.message_received",
          content: {
            folder: resource,
            uidValidity: data.uidValidity,
            uid: message.uid,
          },
        })),
        more: data.more,
      };
    },
  };
}
