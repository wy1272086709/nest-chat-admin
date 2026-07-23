import { Module } from '@nestjs/common';
import { AuthModule } from '@/common/auth/auth-business.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatAiService } from './moderation/chat-ai.service';
import { ChatModerationService } from './moderation/chat-moderation.service';
import { ChatModerationQueueService } from './moderation/chat-moderation-queue.service';
import { ChatModerationOutboxPublisher } from './moderation/chat-moderation-outbox.publisher';
import { ChatModerationConsumer } from './moderation/chat-moderation.consumer';
import { ChatModerationActionService } from './moderation/chat-moderation-action.service';
import { ChatModerationEnforcementService } from './moderation/chat-moderation-enforcement.service';
import { ChatRestrictionService } from './moderation/chat-restriction.service';

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [
    ChatGateway,
    ChatService,
    ChatAiService,
    ChatModerationService,
    ChatModerationQueueService,
    ChatModerationOutboxPublisher,
    ChatModerationConsumer,
    ChatModerationActionService,
    ChatModerationEnforcementService,
    ChatRestrictionService,
  ],
  exports: [ChatGateway, ChatService, ChatAiService],
})
export class ChatModule {}
