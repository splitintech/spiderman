import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { ConnectorError, type Operation } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import { required } from "@splitin/spiderman-provider-kit";
const id = z.number().int().positive(),
  folder = z.string().min(1).max(300);
export class ImapSmtpProvider implements Provider {
  readonly manifest = {
    provider: "imap-smtp",
    version: "1",
    transport: "email",
    qualification: "automated_only" as const,
    operations: [
      {
        name: "mail.search",
        risk: "read",
        scopes: ["mail"],
        input: z
          .object({
            folder,
            subject: z.string().optional(),
            from: z.email().optional(),
            unseen: z.boolean().optional(),
          })
          .strict(),
      },
      {
        name: "mail.get",
        risk: "read",
        scopes: ["mail"],
        input: z.object({ folder, uid: id }).strict(),
      },
      {
        name: "mail.send",
        risk: "write",
        scopes: ["mail"],
        input: z
          .object({
            recipients: z.array(z.email()).min(1).max(20),
            subject: z.string().max(1000),
            text: z.string().max(100000),
          })
          .strict(),
        recipientKeys: ["recipients"],
      },
    ] satisfies Operation[],
  };
  constructor(readonly allowedHosts: readonly string[]) {}
  config(c: Record<string, unknown>, kind: "imap" | "smtp") {
    const host = required(c, kind + "Host");
    if (!this.allowedHosts.includes(host) || /[/@:\s]/.test(host))
      throw new ConnectorError("mail_host_not_allowlisted");
    return {
      host,
      port: kind === "imap" ? 993 : 465,
      secure: true,
      auth: { user: required(c, "username"), pass: required(c, "password") },
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" as const },
      logger: false as const,
    };
  }
  async verify(c: Record<string, unknown>) {
    const imap = new ImapFlow(this.config(c, "imap"));
    try {
      await imap.connect();
      await imap.logout();
      const smtp = nodemailer.createTransport(this.config(c, "smtp"));
      try {
        await smtp.verify();
      } finally {
        smtp.close();
      }
      return { accountId: required(c, "username"), scopes: ["mail"] };
    } catch {
      throw new ConnectorError("mail_auth_failed");
    }
  }
  async execute(
    name: string,
    raw: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const spec = this.manifest.operations.find((o) => o.name === name);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(raw) as any;
    if (name === "mail.send") {
      const smtp = nodemailer.createTransport(
        this.config(ctx.credentials, "smtp"),
      );
      try {
        const result = await smtp.sendMail({
          from: ctx.connection.accountId,
          to: a.recipients,
          subject: a.subject,
          text: a.text,
          messageId: "<" + ctx.actionId + "@spiderman.local>",
        });
        return {
          providerId: result.messageId,
          data: {
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            delivery: "smtp_accepted_not_recipient_delivery",
          },
        };
      } catch {
        throw new ConnectorError("smtp_outcome_uncertain", true);
      } finally {
        smtp.close();
      }
    }
    const imap = new ImapFlow(this.config(ctx.credentials, "imap"));
    try {
      await imap.connect();
      const lock = await imap.getMailboxLock(a.folder);
      try {
        if (name === "mail.search")
          return {
            data: {
              uids: await imap.search(
                {
                  subject: a.subject,
                  from: a.from,
                  seen: a.unseen === undefined ? undefined : !a.unseen,
                },
                { uid: true },
              ),
            },
          };
        const message = await imap.fetchOne(
          String(a.uid),
          { uid: true, envelope: true, source: true },
          { uid: true },
        );
        return {
          data: message
            ? {
                uid: message.uid,
                envelope: message.envelope,
                source: message.source?.toString("base64"),
              }
            : null,
        };
      } finally {
        lock.release();
      }
    } catch {
      throw new ConnectorError("imap_operation_failed");
    } finally {
      await imap.logout().catch(() => {});
    }
  }
}
