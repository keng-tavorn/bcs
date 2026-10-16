import { chatIntakeMessageHandler } from '@/server/line/chat-intake'
import { registerLineMessageHandler } from '@/server/line/webhook'
import { chatIntakeSettingsOfOrganization, discardChatText } from '.'
import { receiveChatMessage } from './receive'

// Plugs asking through the chat into the LINE webhook (S17-06): the chat side of src/server/line/chat-intake.ts with the
// service's command (src/server/line may not import services). Registered when the module loads;
// src/server/jobs/line-webhook.ts imports it, so the webhook route and the line-webhook job both know it.

registerLineMessageHandler(chatIntakeMessageHandler({ settingsOf: chatIntakeSettingsOfOrganization, receive: receiveChatMessage, discardText: discardChatText }))
