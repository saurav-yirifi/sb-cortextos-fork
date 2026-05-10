import { describe, it, expect } from 'vitest';
import { shouldForwardMessage, SERVICE_MESSAGE_FIELDS, type BotIdentity } from '../../../src/telegram/filter';
import type { TelegramMessage } from '../../../src/types';

const BOT: BotIdentity = { id: 1234567890, username: 'sb_fullstack_bot' };

function baseMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    from: { id: 999, first_name: 'Saurav', username: 'sauravb' },
    chat: { id: -1001234, type: 'supergroup' },
    text: '',
    ...overrides,
  };
}

describe('shouldForwardMessage', () => {
  describe('private chat (rule 1)', () => {
    it('forwards a DM with arbitrary text', () => {
      const msg = baseMessage({ chat: { id: 999, type: 'private' }, text: 'hi' });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: true,
        reason: 'private_chat',
      });
    });

    it('forwards a DM even if it carries a service-message-shaped field', () => {
      // Edge case spec'd in filter.ts header — DMs trump the
      // service-message check because the bot IS the recipient.
      const msg = baseMessage({
        chat: { id: 999, type: 'private' },
        // pinned_message can occur inside DMs in rare cases.
        ...({ pinned_message: { message_id: 5 } } as Partial<TelegramMessage>),
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(true);
    });
  });

  describe('service messages (rule 2)', () => {
    it.each(SERVICE_MESSAGE_FIELDS.map((f) => [f]))(
      'drops a group message carrying the %s field',
      (field) => {
        const msg = baseMessage({
          ...({ [field]: { id: 1 } } as Partial<TelegramMessage>),
        });
        expect(shouldForwardMessage(msg, BOT)).toEqual({
          forward: false,
          reason: 'service_message',
        });
      },
    );

    it('treats a value of 0 (e.g. migrate_to_chat_id=0) as present and drops', () => {
      // Telegram never emits 0 here, but `!= null` semantics matter for
      // the trap class — `0` is a valid present value.
      const msg = baseMessage({
        ...({ migrate_to_chat_id: 0 } as Partial<TelegramMessage>),
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(false);
    });

    it('treats explicit null as absent (forwards if otherwise mentioned)', () => {
      const msg = baseMessage({
        text: '@sb_fullstack_bot ping',
        entities: [{ type: 'mention', offset: 0, length: 17 }],
        ...({ pinned_message: null } as Partial<TelegramMessage>),
      });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: true,
        reason: 'mentioned',
      });
    });
  });

  describe('reply to bot (rule 3)', () => {
    it('forwards a reply where reply_to_message.from.id matches the bot', () => {
      const msg = baseMessage({
        text: 'thanks',
        reply_to_message: {
          message_id: 5,
          chat: { id: -1001234, type: 'supergroup' },
          from: { id: BOT.id, first_name: 'fullstack', username: BOT.username },
        },
      });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: true,
        reason: 'reply_to_us',
      });
    });

    it('does not forward a reply chained via a third party (bot is in chain but not immediate target)', () => {
      // Reply chain: A → B → C. B is the immediate target. The bot
      // appearing earlier in the chain doesn't count.
      const msg = baseMessage({
        text: '@otheruser noted',
        reply_to_message: {
          message_id: 5,
          chat: { id: -1001234, type: 'supergroup' },
          from: { id: 555, first_name: 'A', username: 'a' },
        },
      });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: false,
        reason: 'no_mention',
      });
    });
  });

  describe('@-mention via entities (rule 4)', () => {
    it('forwards a message with a `mention` entity matching the bot username', () => {
      const text = '@sb_fullstack_bot can you check this';
      const msg = baseMessage({
        text,
        entities: [{ type: 'mention', offset: 0, length: 17 }],
      });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: true,
        reason: 'mentioned',
      });
    });

    it('matches case-insensitively', () => {
      // BotFather usernames can be mixed case; getMe normalises but
      // operators sometimes type the @ with different casing.
      const text = 'hey @SB_Fullstack_Bot ping';
      const msg = baseMessage({
        text,
        entities: [{ type: 'mention', offset: 4, length: 17 }],
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(true);
    });

    it('drops a message that mentions a different bot only', () => {
      const text = '@some_other_bot do the thing';
      const msg = baseMessage({
        text,
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: false,
        reason: 'no_mention',
      });
    });

    it('forwards when our bot is one of multiple @-mentions', () => {
      const text = '@a_bot @sb_fullstack_bot @b_bot triage this';
      const msg = baseMessage({
        text,
        entities: [
          { type: 'mention', offset: 0, length: 6 },
          { type: 'mention', offset: 7, length: 17 },
          { type: 'mention', offset: 25, length: 6 },
        ],
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(true);
    });

    it('forwards when the mention lives in caption_entities (media post)', () => {
      const msg = baseMessage({
        text: undefined,
        caption: '@sb_fullstack_bot photo question',
        caption_entities: [{ type: 'mention', offset: 0, length: 17 }],
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(true);
    });

    it('forwards on `text_mention` entity referencing the bot user id', () => {
      // Used for accounts without a public @username (rare for bots,
      // but defensive coverage).
      const msg = baseMessage({
        text: 'fullstack take a look',
        entities: [
          {
            type: 'text_mention',
            offset: 0,
            length: 9,
            user: { id: BOT.id, first_name: 'fullstack' },
          },
        ],
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(true);
    });

    it('does NOT forward on `text_mention` entity referencing a different user id', () => {
      const msg = baseMessage({
        text: 'saurav take a look',
        entities: [
          {
            type: 'text_mention',
            offset: 0,
            length: 6,
            user: { id: 999, first_name: 'Saurav' },
          },
        ],
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(false);
    });

    it('drops a forwarded message whose @-mention substring is in plain text but not in entities', () => {
      // Telegram strips entities on forward; the visible @username text
      // is just text, no `mention` entity. We rely on entities, so this
      // does not match. (Per spec edge-case table.)
      const msg = baseMessage({
        text: 'fwd: @sb_fullstack_bot help',
        // Note: no entities array.
      });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: false,
        reason: 'no_mention',
      });
    });

    it('drops when entities array is present but contains no mention', () => {
      const msg = baseMessage({
        text: 'see https://example.com',
        entities: [{ type: 'url', offset: 4, length: 19 }],
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(false);
    });
  });

  describe('catch-all (rule 5)', () => {
    it('drops a plain group message with no mention, no reply, no service field', () => {
      const msg = baseMessage({ text: 'random group chatter' });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: false,
        reason: 'no_mention',
      });
    });

    it('drops an empty-text group message (privacy-mode leak shape)', () => {
      const msg = baseMessage({ text: '' });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(false);
    });

    it('drops a channel post with no @-mention', () => {
      const msg = baseMessage({
        chat: { id: -1009999, type: 'channel' },
        text: 'channel announcement',
      });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: false,
        reason: 'no_mention',
      });
    });

    it('forwards a channel post that @-mentions the bot', () => {
      const msg = baseMessage({
        chat: { id: -1009999, type: 'channel' },
        text: '@sb_fullstack_bot announcement',
        entities: [{ type: 'mention', offset: 0, length: 17 }],
      });
      expect(shouldForwardMessage(msg, BOT).forward).toBe(true);
    });
  });

  describe('order of checks', () => {
    it('private chat short-circuits before mention check (DM with no mention still passes)', () => {
      const msg = baseMessage({ chat: { id: 999, type: 'private' }, text: 'hello' });
      expect(shouldForwardMessage(msg, BOT).reason).toBe('private_chat');
    });

    it('service-message check fires before mention check (service msg even with @-mention is dropped)', () => {
      const msg = baseMessage({
        text: '@sb_fullstack_bot pinned this',
        entities: [{ type: 'mention', offset: 0, length: 17 }],
        ...({ pinned_message: { message_id: 5 } } as Partial<TelegramMessage>),
      });
      expect(shouldForwardMessage(msg, BOT)).toEqual({
        forward: false,
        reason: 'service_message',
      });
    });
  });
});
