import { Module } from '@nestjs/common';
import { AuthModule } from '@/common/auth/auth-business.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatAiService } from './chat-ai.service';
import { ChatModerationService } from './chat-moderation.service';
import { ChatModerationQueueService } from './chat-moderation-queue.service';
import { ChatModerationOutboxPublisher } from './chat-moderation-outbox.publisher';
import { ChatModerationConsumer } from './chat-moderation.consumer';
import { ChatModerationActionService } from './chat-moderation-action.service';
import { ChatModerationEnforcementService } from './chat-moderation-enforcement.service';
import { ChatRestrictionService } from './chat-restriction.service';

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
