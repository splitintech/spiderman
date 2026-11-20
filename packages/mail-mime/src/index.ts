// Adapted from splitintech/carl-allen (MIT), commit 9e1ff74f2f96240392f49bb0e25d7e2bdf9335e9.
// Copyright (c) 2026 SplitInTech. Modified to add bounded attachments and a generic transport contract.
import { randomBytes } from "node:crypto";
export interface EmailAddress {
  address: string;
  name?: string;
}
export interface ApprovedEmail {
  from: EmailAddress;
  to: readonly EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  rfcMessageId: string;
  inReplyTo?: string;
  references?: readonly string[];
  headers: Readonly<Record<string, string>>;
  idempotencyKey: string;
  text: string;
  html?: string;
  attachments?: readonly {
    filename: string;
    contentType: string;
    contentBase64: string;
  }[];
}

/** The message cannot be expressed safely as MIME (header injection, reserved header, bad address). */
const mimeErrorBrand=Symbol.for('net.splitin.spiderman.mime-error.v1');
export class MimeError extends Error {
  readonly [mimeErrorBrand]=true;
  static [Symbol.hasInstance](value:unknown){return !!value&&typeof value==='object'&&(value as MimeError)[mimeErrorBrand]===true;}
  constructor(message: string) {
    super(message);
    this.name = "MimeError";
  }
}

/** Header the adapter adds to every message; reconciliation matches on it. */
export const IDEMPOTENCY_HEADER = "X-Spiderman-Key";

/** Headers the adapter owns. Callers pass anything else (List-Unsubscribe, ...) through `headers`. */
const RESERVED = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);
const HEADER_NAME = /^[!-9;-~]+$/;
const ADDRESS = /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+$/;
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

function assertNoBreaks(value: string, what: string): void {
  if (/[\r\n\0]/.test(value))
    throw new MimeError(`${what} contains a line break`);
}

/** RFC 2047 encoded words of at most 45 UTF-8 bytes each (so every word stays under 75 characters). */
function encodeWords(value: string): string {
  if (ASCII_PRINTABLE.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`,
    )
    .join("\r\n ");
}

function formatAddress(address: EmailAddress, what: string): string {
  assertNoBreaks(address.address, what);
  if (!ADDRESS.test(address.address))
    throw new MimeError(
      `${what} "${address.address.slice(0, 80)}" is not a plain address`,
    );
  if (!address.name) return address.address;
  assertNoBreaks(address.name, `${what} name`);
  const name = ASCII_PRINTABLE.test(address.name)
    ? `"${address.name.replace(/["\\]/g, "\\$&")}"`
    : encodeWords(address.name);
  return `${name} <${address.address}>`;
}

function base64Lines(text: string): string {
  return (
    Buffer.from(text, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
}

function messageIdToken(value: string, what: string): string {
  assertNoBreaks(value, what);
  if (!/^<[^<>\s]+>$/.test(value))
    throw new MimeError(`${what} must look like <id@domain>`);
  return value;
}

/**
 * Builds an RFC 5322 message with CRLF line endings. Bodies are base64 (UTF-8); with HTML the message is
 * multipart/alternative with the text part first.
 */
export function buildMime(
  email: ApprovedEmail,
  date: Date,
  boundary = `=_spiderman_${randomBytes(12).toString("hex")}`,
  options:{idempotencyHeader?:string}={},
): string {
  const key=options.idempotencyHeader??IDEMPOTENCY_HEADER;
  if(!/^X-[A-Za-z0-9-]{1,100}$/.test(key))throw new MimeError('invalid idempotency header');
  if (email.to.length === 0)
    throw new MimeError("a message needs at least one recipient");
  const lines: string[] = [
    `From: ${formatAddress(email.from, "From")}`,
    `To: ${email.to.map((to) => formatAddress(to, "To")).join(", ")}`,
  ];
  if (email.replyTo)
    lines.push(`Reply-To: ${formatAddress(email.replyTo, "Reply-To")}`);
  assertNoBreaks(email.subject, "Subject");
  lines.push(
    `Subject: ${encodeWords(email.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageIdToken(email.rfcMessageId, "Message-ID")}`,
  );
  if (email.inReplyTo)
    lines.push(
      `In-Reply-To: ${messageIdToken(email.inReplyTo, "In-Reply-To")}`,
    );
  if (email.references?.length)
    lines.push(
      `References: ${email.references.map((id) => messageIdToken(id, "References")).join(" ")}`,
    );
  for (const [name, value] of Object.entries(email.headers)) {
    if (!HEADER_NAME.test(name))
      throw new MimeError(`invalid header name "${name.slice(0, 40)}"`);
    if (RESERVED.has(name.toLowerCase())||name.toLowerCase()===key.toLowerCase())
      throw new MimeError(`header ${name} is set by the adapter`);
    assertNoBreaks(value, `header ${name}`);
    lines.push(
      `${name}: ${ASCII_PRINTABLE.test(value) ? value : encodeWords(value)}`,
    );
  }
  assertNoBreaks(email.idempotencyKey, key);
  lines.push(
    `${key}: ${email.idempotencyKey}`,
    "MIME-Version: 1.0",
  );

  const textPart = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(email.text),
  ];
  const content = !email.html ? [...textPart] : undefined;
  if (!email.html && !email.attachments?.length)
    return [...lines, ...textPart, ""].join("\r\n");
  const htmlPart = [
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(email.html ?? ""),
  ];
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    ...htmlPart,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  if (!email.attachments?.length) return [...lines, alternative].join("\r\n");
  if (email.attachments.length > 10)
    throw new MimeError("attachment limit exceeded");
  let total = 0;
  const mixed = boundary + "_mixed",
    parts = [(content ?? [alternative]).join("\r\n")];
  for (const attachment of email.attachments) {
    if (
      !/^[A-Za-z0-9_. -]{1,120}$/.test(attachment.filename) ||
      !/^[-\w.+]+\/[-\w.+]+$/.test(attachment.contentType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        attachment.contentBase64,
      )
    )
      throw new MimeError("invalid attachment");
    const bytes = Buffer.from(attachment.contentBase64, "base64");
    total += bytes.length;
    if (total > 5_000_000) throw new MimeError("attachment size exceeded");
    parts.push(
      [
        "Content-Type: " + attachment.contentType,
        'Content-Disposition: attachment; filename="' +
          attachment.filename +
          '"',
        "Content-Transfer-Encoding: base64",
        "",
        (bytes.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
      ].join("\r\n"),
    );
  }
  return [
    ...lines,
    'Content-Type: multipart/mixed; boundary="' + mixed + '"',
    "",
    ...parts.flatMap((part) => ["--" + mixed, part]),
    "--" + mixed + "--",
    "",
  ].join("\r\n");
}
