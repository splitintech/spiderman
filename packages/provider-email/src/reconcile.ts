import { ConnectorError } from "@splitin/spiderman-contracts";
import type { ReconciliationStrategy } from "@splitin/spiderman-core";

/** SMTP never guarantees recipient delivery. An existing Sent copy only proves a recorded submission. */
export function imapReconciliationStrategy(): ReconciliationStrategy {
  return {
    provider: "imap-smtp",
    operations: ["mail.send"],
    request(action, _input, resource) {
      if (!resource) throw new ConnectorError("sent_folder_required");
      return {
        operation: "mail.reconcile",
        input: { folder: resource, actionId: action.id },
      };
    },
    resolve(raw, action, input) {
      const data = raw as {
        actionId?: string;
        messages?: {
          uid: number;
          uidValidity: string;
          folder: string;
          messageId: string;
          from?: string[];
          recipients?: string[];
        }[];
      };
      if (data?.actionId !== action.id || !Array.isArray(data.messages)) return;
      const canonical = (items: unknown) =>
        Array.isArray(items) && items.every((x) => typeof x === "string")
          ? items
              .map((x: string) => x.toLowerCase())
              .sort()
              .join("\n")
          : undefined;
      const match = data.messages.find(
        (m) =>
          m.messageId === "<" + action.id + "@spiderman.local>" &&
          Number.isSafeInteger(m.uid) &&
          m.uid > 0 &&
          /^\d+$/.test(m.uidValidity) &&
          canonical(m.recipients) === canonical(input.recipients),
      );
      if (match)
        return {
          providerId: match.messageId,
          data: {
            ...match,
            delivery: "sent_copy_verified_not_recipient_delivery",
          },
        };
    },
  };
}
