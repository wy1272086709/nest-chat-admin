import { Module } from '@nestjs/common';
import { AuthModule } from '@/common/auth/auth-business.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatAiService } from './chat-ai.service';

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [ChatGateway, ChatService, ChatAiService],
  exports: [ChatGateway, ChatService, ChatAiService],
})
export class ChatModule {}
