/**
 * Programmatic Telegram inbound-message filter.
 *
 * Defense-in-depth on top of Telegram's bot privacy setting: enforce, at
 * the cortextos boundary, that group/supergroup/channel messages reach
 * the agent only when explicitly addressed to it. Three Telegram leak
 * modes that this filter closes:
 *
 *   1. admin override — making a bot admin in a group bypasses privacy
 *      mode entirely; bot sees every message.
 *   2. group-join-time stickiness — privacy changes only apply to groups
 *      the bot joins AFTER the change; existing memberships keep prior
 *      state until the bot is kicked + re-added.
 *   3. service-message bypass — chat upgrade events, new_chat_members,
 *      pinned_message, migrate_to/from_chat_id, voice/video_chat_started
 *      etc. reach bots regardless of privacy because they are environment
 *      metadata, not group conversation. They have empty text and pollute
 *      agent context if forwarded.
 *
 * DMs (chat.type === 'private') always pass through unchanged because
 * the bot is by definition the recipient.
 *
 * See orgs/sb-personal/backlog/BL-2026-05-10-001-mention-only-filter.md
 * for the full architecture and decision tree.
 */

import type { TelegramMessage } from '../types/index.js';

/**
 * The bot's own identity, resolved once via getMe at poller boot and
 * cached on disk in `state/<agent>/bot-identity.json`. Both fields are
 * stable per bot token, so a single fetch is sufficient and surviving a
 * daemon restart via the disk cache avoids re-fetching on every boot.
 */
export interface BotIdentity {
  /** Bot's Telegram user id. Used to detect "reply to us" via reply_to_message.from.id. */
  id: number;
  /** Bot's @username, no leading @, lowercase canonical form (Telegram normalises). */
  username: string;
}

/**
 * Result of the filter. Tagged-union with a `reason` discriminant so the
 * filtered-inbound diagnostic log can record WHY each filtered message
 * was dropped — without that, debugging "why didn't this message reach
 * the agent" requires re-running the filter by hand.
 */
export type ForwardDecision =
  | { forward: true; reason: 'private_chat' | 'reply_to_us' | 'mentioned' }
  | { forward: false; reason: 'service_message' | 'no_mention' };

/**
 * Telegram service-message field names. A message with ANY of these
 * fields set is environment metadata, not group conversation, and is
 * dropped at the filter regardless of @-mention state.
 *
 * This list is intentionally broad (covers historical and current
 * service-message types from the Telegram Bot API) so newly-added
 * service messages of similar shape are handled by an explicit field
 * rather than leaking through. Detection is by structural presence
 * (`field in msg && msg[field] != null`), not by type narrowing —
 * forward-compat with future Telegram additions of similarly-shaped
 * fields would only require appending to this list.
 */
export const SERVICE_MESSAGE_FIELDS: readonly string[] = [
  'new_chat_members',
  'left_chat_member',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
  'pinned_message',
  'voice_chat_started',
  'voice_chat_ended',
  'voice_chat_participants_invited',
  'voice_chat_scheduled',
  'video_chat_started',
  'video_chat_ended',
  'video_chat_participants_invited',
  'video_chat_scheduled',
  'message_auto_delete_timer_changed',
  'connected_website',
  'forum_topic_created',
  'forum_topic_closed',
  'forum_topic_reopened',
  'forum_topic_edited',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'web_app_data',
  'invoice',
  'successful_payment',
  'proximity_alert_triggered',
  'write_access_allowed',
  'boost_added',
  'chat_shared',
  'users_shared',
  'giveaway',
  'giveaway_created',
  'giveaway_winners',
  'giveaway_completed',
] as const;

const SERVICE_MESSAGE_FIELD_SET = new Set<string>(SERVICE_MESSAGE_FIELDS);

/**
 * Pure function: decide whether an inbound Telegram message should be
 * forwarded to the agent session. See decision tree in BL-2026-05-10-001
 * spec § Architecture.
 *
 * Order matters — `private_chat` and `service_message` are checked
 * first because they short-circuit independent of the bot identity, then
 * the addressed-to-us checks (reply, mention) proceed.
 *
 * Edge cases the order accommodates:
 *  - A private chat with the bot can still technically include service
 *    messages (rare, but Telegram permits e.g. pinned_message in DMs).
 *    DMs trump the service-message check because the bot IS the
 *    recipient — dropping pinned-in-DM is more surprising than letting
 *    it through.
 *  - A reply to the bot in a group MUST NOT trigger the @-mention
 *    branch's case-insensitive comparison failure mode; reply detection
 *    is by user-id equality, never by username string.
 */
export function shouldForwardMessage(
  msg: TelegramMessage,
  botIdentity: BotIdentity,
): ForwardDecision {
  // 1. DMs always pass — bot is by definition the recipient.
  if (msg.chat?.type === 'private') {
    return { forward: true, reason: 'private_chat' };
  }

  // 2. Service messages: drop. Detection is structural — any known
  //    service-message field present (and non-null) is sufficient.
  const msgRecord = msg as unknown as Record<string, unknown>;
  for (const field of SERVICE_MESSAGE_FIELD_SET) {
    if (msgRecord[field] != null) {
      return { forward: false, reason: 'service_message' };
    }
  }

  // 3. Reply addressed to us — by user id, not username.
  if (msg.reply_to_message?.from?.id === botIdentity.id) {
    return { forward: true, reason: 'reply_to_us' };
  }

  // 4. @-mention via entities. Telegram emits two relevant entity types:
  //    - `mention`: classic @username form, username substring lives in
  //      the surrounding text at [offset, offset+length).
  //    - `text_mention`: tagged-user form (private mention or no-username
  //      account), entity carries an explicit `user` object.
  //    Caption entities matter when the message is a media post with a
  //    caption that mentions the bot.
  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const expectedMention = `@${botIdentity.username.toLowerCase()}`;

  for (const ent of entities) {
    if (ent.type === 'mention') {
      const mentionText = text
        .slice(ent.offset, ent.offset + ent.length)
        .toLowerCase();
      if (mentionText === expectedMention) {
        return { forward: true, reason: 'mentioned' };
      }
      continue;
    }
    if (ent.type === 'text_mention' && ent.user?.id === botIdentity.id) {
      return { forward: true, reason: 'mentioned' };
    }
  }

  return { forward: false, reason: 'no_mention' };
}
