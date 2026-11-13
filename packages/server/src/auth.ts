import { jwtVerify } from "jose";
export interface Principal {
  owner: string;
  kind: "human" | "agent";
}
export function delegatedAuthenticator(
  secret: string,
  issuer = "splitin",
  audience = "spiderman",
) {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("delegation_secret_too_short");
  return async (token: string): Promise<Principal | undefined> => {
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(secret),
        {
          issuer,
          audience,
          algorithms: ["HS256"],
          maxTokenAge: "2m",
          clockTolerance: 5,
        },
      );
      if (
        typeof payload.sub !== "string" ||
        !payload.sub ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > 120 ||
        !["human", "agent"].includes(String(payload.actor_kind))
      )
        return;
      return {
        owner: payload.sub,
        kind: payload.actor_kind as Principal["kind"],
      };
    } catch {
      return;
    }
  };
}
