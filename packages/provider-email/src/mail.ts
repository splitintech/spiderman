import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { ConnectorError, type Operation } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import { required, buildMime } from "@splitin/spiderman-provider-kit";
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
        name: "mail.reconcile",
        risk: "read",
        scopes: ["mail"],
        input: z
          .object({ folder, actionId: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
        resourceKeys: ["folder"],
      },
      {
        name: "mail.folders",
        risk: "read",
        scopes: ["mail"],
        input: z.object({}).strict(),
      },
      {
        name: "mail.capabilities",
        risk: "read",
        scopes: ["mail"],
        input: z.object({}).strict(),
      },
      {
        name: "mail.changes",
        risk: "read",
        scopes: ["mail"],
        input: z
          .object({
            folder,
            uidValidity: z.string().optional(),
            afterUid: z.number().int().nonnegative().optional(),
          })
          .strict(),
        resourceKeys: ["folder"],
      },
      {
        name: "mail.attachment",
        risk: "read",
        scopes: ["mail"],
        input: z
          .object({
            folder,
            uid: id,
            part: z.string().regex(/^\d+(?:\.\d+)*$/),
          })
          .strict(),
        resourceKeys: ["folder"],
        stagedResult: true,
      },
      {
        name: "mail.flags",
        risk: "write",
        scopes: ["mail"],
        input: z
          .object({
            folder,
            uid: id,
            uidValidity: z.string().min(1),
            add: z
              .array(z.enum(["\\Seen", "\\Flagged", "\\Answered"]))
              .max(3)
              .default([]),
            remove: z
              .array(z.enum(["\\Seen", "\\Flagged", "\\Answered"]))
              .max(3)
              .default([]),
          })
          .strict(),
        resourceKeys: ["folder"],
      },
      {
        name: "mail.trash",
        risk: "destructive",
        scopes: ["mail"],
        input: z
          .object({ folder, uid: id, uidValidity: z.string().min(1) })
          .strict(),
        resourceKeys: ["folder"],
      },
      {
        name: "mail.move",
        risk: "write",
        scopes: ["mail"],
        input: z
          .object({
            folder,
            uid: id,
            uidValidity: z.string().min(1),
            destination: folder,
          })
          .strict(),
        resourceKeys: ["folder", "destination"],
      },
      {
        name: "mail.draft",
        risk: "draft",
        scopes: ["mail"],
        input: z
          .object({
            folder,
            recipients: z.array(z.email()).min(1).max(20),
            subject: z.string().max(1000),
            text: z.string().max(100000),
          })
          .strict(),
        resourceKeys: ["folder"],
      },
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
    if (
      [
        "imap.gmail.com",
        "smtp.gmail.com",
        "imap.googlemail.com",
        "smtp.googlemail.com",
        "outlook.office365.com",
        "smtp.office365.com",
        "imap-mail.outlook.com",
        "smtp-mail.outlook.com",
      ].includes(host.toLowerCase())
    )
      throw new ConnectorError("native_oauth_connector_required");
    z.email().parse(c.username);
    if (
      c.authType !== undefined &&
      c.authType !== "password" &&
      c.authType !== "oauth2"
    )
      throw new ConnectorError("mail_auth_type_invalid");
    if (
      c.authType === "oauth2" &&
      c.expiresAt !== undefined &&
      (typeof c.expiresAt !== "number" || c.expiresAt <= Date.now())
    )
      throw new ConnectorError("mail_oauth_token_expired");
    const auth =
      c.authType === "oauth2"
        ? kind === "imap"
          ? {
              user: required(c, "username"),
              accessToken: required(c, "accessToken"),
            }
          : {
              type: "OAuth2" as const,
              user: required(c, "username"),
              accessToken: required(c, "accessToken"),
            }
        : { user: required(c, "username"), pass: required(c, "password") };
    return {
      host,
      port: kind === "imap" ? 993 : 465,
      secure: true,
      auth,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" as const },
      logger: false as const,
    };
  }
  imap(c: Record<string, unknown>) {
    return new ImapFlow(this.config(c, "imap"));
  }
  smtp(c: Record<string, unknown>) {
    return nodemailer.createTransport(this.config(c, "smtp"));
  }
  async verify(c: Record<string, unknown>) {
    const imap = this.imap(c);
    try {
      await imap.connect();
      await imap.logout();
      const smtp = this.smtp(c);
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
      const smtp = this.smtp(ctx.credentials);
      try {
        await ctx.beforeDispatch?.();
        const result = await smtp.sendMail({
          from: ctx.connection.accountId,
          to: a.recipients,
          subject: a.subject,
          text: a.text,
          messageId: "<" + ctx.actionId + "@spiderman.local>",
        });
        if (!result.messageId || !result.accepted?.length)
          throw new ConnectorError("smtp_not_accepted");
        return {
          providerId: result.messageId,
          data: {
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            delivery: "smtp_accepted_not_recipient_delivery",
          },
        };
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError("smtp_outcome_uncertain", true);
      } finally {
        smtp.close();
      }
    }
    const imap = this.imap(ctx.credentials);
    try {
      await imap.connect();
      await ctx.beforeDispatch?.();
      if (name === "mail.folders")
        return {
          data: {
            folders: (await imap.list()).map((f) => ({
              path: f.path,
              name: f.name,
              specialUse: f.specialUse,
              delimiter: f.delimiter,
            })),
          },
        };
      if (name === "mail.capabilities")
        return {
          data: {
            capabilities: [...imap.capabilities.keys()],
            folders: (await imap.list()).map((f) => ({
              path: f.path,
              specialUse: f.specialUse,
            })),
          },
        };
      const lock = await imap.getMailboxLock(a.folder);
      try {
        await ctx.beforeDispatch?.();
        const mailbox = imap.mailbox;
        if (!mailbox) throw new ConnectorError("mailbox_unavailable");
        const uidValidity = String(mailbox.uidValidity);
        if (a.uidValidity !== undefined && a.uidValidity !== uidValidity)
          throw new ConnectorError("imap_cursor_invalid");
        if (name === "mail.reconcile") {
          const sent = (await imap.list()).find(
            (f) => f.path === a.folder && f.specialUse === "\\Sent",
          );
          if (!sent && ctx.credentials.sentFolder !== a.folder)
            throw new ConnectorError("sent_folder_unverified");
          const messageId = "<" + a.actionId + "@spiderman.local>";
          const found = await imap.search(
            { header: { "message-id": messageId } },
            { uid: true },
          );
          const candidates = (found || []).slice(0, 10);
          const messages = [];
          for (const uid of candidates) {
            await ctx.beforeDispatch?.();
            const message = await imap.fetchOne(
              String(uid),
              { envelope: true },
              { uid: true },
            );
            if (
              !message ||
              message.envelope?.messageId !== messageId ||
              !message.envelope.from?.some(
                (x) =>
                  x.address?.toLowerCase() ===
                  ctx.connection.accountId.toLowerCase(),
              )
            )
              continue;
            messages.push({
              uid,
              uidValidity,
              folder: a.folder,
              messageId,
              from: message.envelope.from?.map((x) => x.address),
              recipients: message.envelope.to?.map((x) => x.address),
            });
          }
          return { data: { actionId: a.actionId, messages } };
        }
        if (name === "mail.changes") {
          if (a.afterUid === undefined)
            return {
              data: {
                uidValidity,
                lastUid: Math.max(0, (mailbox.uidNext ?? 1) - 1),
                messages: [],
              },
            };
          const found = await imap.search(
            { uid: a.afterUid + 1 + ":*" },
            { uid: true },
          );
          const uids = (found || [])
            .filter((uid) => uid > a.afterUid)
            .sort((a, b) => a - b)
            .slice(0, 100);
          return {
            data: {
              uidValidity,
              lastUid: uids.at(-1) ?? a.afterUid,
              messages: uids.map((uid) => ({ uid })),
              more: uids.length === 100,
            },
          };
        }
        if (name === "mail.draft") {
          const mime = buildMime(
            {
              from: { address: ctx.connection.accountId },
              to: a.recipients.map((address: string) => ({ address })),
              subject: a.subject,
              text: a.text,
              rfcMessageId: "<" + ctx.actionId + "@spiderman.local>",
              idempotencyKey: ctx.actionId,
              headers: {},
            },
            new Date(),
          );
          const added = await imap.append(a.folder, Buffer.from(mime), [
            "\\Draft",
          ]);
          if (!added || !added.uid)
            throw new ConnectorError("draft_receipt_missing", true);
          return {
            providerId: uidValidity + ":" + added.uid,
            data: { uid: added.uid, uidValidity, folder: a.folder },
          };
        }
        if (name === "mail.flags") {
          if (a.add.length) {
            await ctx.beforeDispatch?.();
            await imap.messageFlagsAdd(String(a.uid), a.add, { uid: true });
          }
          if (a.remove.length) {
            await ctx.beforeDispatch?.();
            await imap.messageFlagsRemove(String(a.uid), a.remove, {
              uid: true,
            });
          }
          const changed = await imap.fetchOne(
            String(a.uid),
            { flags: true },
            { uid: true },
          );
          if (
            !changed ||
            a.add.some((flag: string) => !changed.flags?.has(flag)) ||
            a.remove.some((flag: string) => changed.flags?.has(flag))
          )
            throw new ConnectorError("mail_flags_unverified", true);
          return {
            providerId: uidValidity + ":" + a.uid,
            data: {
              uid: a.uid,
              uidValidity,
              flags: [...(changed.flags ?? [])],
            },
          };
        }
        if (name === "mail.move" || name === "mail.trash") {
          const trash = (await imap.list()).find(
            (folder) => folder.specialUse === "\\Trash",
          );
          if (!trash) throw new ConnectorError("trash_folder_unverified");
          if (name === "mail.move" && a.destination === trash.path)
            throw new ConnectorError("use_explicit_trash_operation");
          if (name === "mail.trash") a.destination = trash.path;
          await ctx.beforeDispatch?.();
          const moved = await imap.messageMove(String(a.uid), a.destination, {
            uid: true,
          });
          if (!moved) throw new ConnectorError("mail_move_unverified", true);
          return {
            providerId: uidValidity + ":" + a.uid,
            data: {
              uid: a.uid,
              uidValidity,
              destination: a.destination,
              mappedUid: moved.uidMap?.get(a.uid),
            },
          };
        }
        if (name === "mail.attachment") {
          const downloaded = await imap.download(String(a.uid), a.part, {
            uid: true,
            maxBytes: 6_000_000,
          });
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of downloaded.content) {
            size += chunk.length;
            if (size > 6_000_000) {
              downloaded.content.destroy();
              throw new ConnectorError("attachment_too_large");
            }
            chunks.push(chunk);
          }
          return {
            data: {
              contentBase64: Buffer.concat(chunks).toString("base64"),
              contentType: downloaded.meta.contentType,
              filename: downloaded.meta.filename ?? "attachment.bin",
            },
          };
        }
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
        const metadata = await imap.fetchOne(
          String(a.uid),
          { size: true },
          { uid: true },
        );
        if (!metadata) throw new ConnectorError("message_not_found");
        if ((metadata.size ?? 0) > 8_000_000)
          throw new ConnectorError("message_too_large");
        const message = await imap.fetchOne(
          String(a.uid),
          {
            uid: true,
            envelope: true,
            source: true,
            bodyStructure: true,
            flags: true,
          },
          { uid: true },
        );
        return {
          data: message
            ? {
                uid: message.uid,
                uidValidity,
                bodyStructure: message.bodyStructure,
                flags: [...(message.flags ?? [])],
                envelope: message.envelope,
                source: message.source?.toString("base64"),
              }
            : null,
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("imap_operation_failed", spec.risk !== "read");
    } finally {
      await imap.logout().catch(() => {});
    }
  }
}
