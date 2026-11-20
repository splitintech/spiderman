import type { ReconciliationStrategy } from "@splitin/spiderman-core";
export function googleReconciliationStrategies(): ReconciliationStrategy[] {
  return [
    {
      provider: "gmail",
      operations: ["mail.send", "mail.reply", "mail.forward"],
      request(action) {
        return { operation: "mail.reconcile", input: { actionId: action.id } };
      },
      resolve(raw, action) {
        const data = raw as { matchedActionId?: string; providerId?: string };
        if (
          data.matchedActionId === action.id &&
          typeof data.providerId === "string" &&
          data.providerId
        )
          return { providerId: data.providerId, data };
      },
    },
    {
      provider: "google-calendar",
      operations: ["calendar.create", "calendar.update"],
      request(action, input) {
        return {
          operation: "calendar.get",
          input: {
            calendarId: input.calendarId,
            eventId: input.eventId ?? action.id.slice(0, 32),
          },
        };
      },
      resolve(raw, action, input) {
        const data = raw as {
          id?: string;
          extendedProperties?: { private?: { spidermanAction?: string } };
        };
        if (
          data.id === (input.eventId ?? action.id.slice(0, 32)) &&
          data.extendedProperties?.private?.spidermanAction === action.id
        )
          return { providerId: data.id, data };
      },
    },
  ];
}
