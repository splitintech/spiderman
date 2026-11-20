export const oauthScopes: Record<string, string[]> = {
  gmail: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
  "google-drive": [
    "openid",
    "email",
    "https://www.googleapis.com/auth/drive.file",
  ],
  "google-sheets": [
    "openid",
    "email",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/spreadsheets",
  ],
  "google-calendar": [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar",
  ],
  outlook: [
    "openid",
    "profile",
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
  ],
};
export const oauthAllowedScopes: Record<string, string[]> = {
  ...oauthScopes,
  gmail: [
    ...oauthScopes.gmail!,
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  "google-drive": [
    ...oauthScopes["google-drive"]!,
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  "google-sheets": [
    ...oauthScopes["google-sheets"]!,
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ],
  "google-calendar": [
    ...oauthScopes["google-calendar"]!,
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.freebusy",
  ],
  outlook: [...oauthScopes.outlook!, "Mail.Read"],
};
export function selectOAuthScopes(provider: string, requested?: string[]) {
  const allowed = oauthAllowedScopes[provider];
  if (!allowed) throw Error("oauth_provider_unavailable");
  if (requested?.some((scope) => !allowed.includes(scope)))
    throw Error("oauth_scope_denied");
  return [
    ...new Set([
      ...(provider === "outlook"
        ? ["openid", "profile", "offline_access", "User.Read"]
        : ["openid", "email"]),
      ...(requested ?? oauthScopes[provider]!),
    ]),
  ];
}
