import type { SyncSource } from "@splitin/spiderman-core";
import { ConnectorError } from "@splitin/spiderman-contracts";
export function outlookSyncSource(): SyncSource {
  return {
    name: "outlook.incoming",
    provider: "outlook",
    expiredCursorErrors: ["provider_http_410"],
    request(_resource, cursor) {
      return {
        operation: "mail.delta",
        input: cursor?.url ? { cursor: cursor.url } : {},
      };
    },
    parse(raw, _resource, cursor) {
      const data = raw as Record<string, any>;
      if (!data || !Array.isArray(data.value))
        throw new ConnectorError("sync_response_invalid");
      const url = data["@odata.nextLink"] ?? data["@odata.deltaLink"];
      if (typeof url !== "string")
        throw new ConnectorError("sync_cursor_missing");
      const u = new URL(url);
      if (
        u.origin !== "https://graph.microsoft.com" ||
        !u.pathname.startsWith("/v1.0/me/")
      )
        throw new ConnectorError("graph_cursor_invalid");
      const bootstrapping = cursor?.bootstrapping !== false,
        more = !!data["@odata.nextLink"];
      const events = bootstrapping
        ? []
        : data.value.map((message: any) => {
            if (typeof message.id !== "string")
              throw new ConnectorError("sync_response_invalid");
            return {
              sourceId:
                "graph:" +
                message.id +
                ":" +
                (message.changeKey ??
                  message.lastModifiedDateTime ??
                  (message["@removed"] ? "deleted" : "observed")),
              type: message["@removed"]
                ? "mail.message_removed"
                : "mail.message_changed",
              content: message,
            };
          });
      return {
        cursor: { url, bootstrapping: bootstrapping && more },
        events,
        more,
      };
    },
  };
}

export function outlookReconciliationStrategy(): import("@splitin/spiderman-core").ReconciliationStrategy {
  return {
    provider: "outlook",
    operations: ["mail.send", "mail.reply", "mail.forward"],
    request(action) {
      if (!action.providerState?.draftId)
        throw new ConnectorError("graph_draft_identity_unavailable");
      return {
        operation: "mail.reconcile",
        input: { draftId: action.providerState.draftId },
      };
    },
    resolve(raw, action) {
      const data = raw as {
        id?: string;
        isDraft?: boolean;
        internetMessageId?: string;
      };
      if (
        data.id === action.providerState?.draftId &&
        data.isDraft === false &&
        typeof data.internetMessageId === "string"
      )
        return {
          providerId: data.id,
          data: { ...data, delivery: "sent_message_verified" },
        };
    },
  };
}
