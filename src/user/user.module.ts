import { Module, forwardRef } from '@nestjs/common';
import { UserService } from './services/user.service';
import { UserController } from './controllers/user.controller';
import { AuthModule } from '../common/auth/auth-business.module';
import { ChatModule } from '@/chat/chat.module';

@Module({
  imports: [forwardRef(() => AuthModule), ChatModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
