import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { TokenRefreshInterceptor } from './interceptors/token-refresh.interceptor';
import { WsTokenRefreshInterceptor } from './interceptors/ws-token-refresh.interceptor';
import { UserModule } from '../../user/user.module';

@Module({
  imports: [
    PassportModule,
    forwardRef(() => UserModule),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
        signOptions: {
          expiresIn: configService.get<string>('jwt.expiresIn') || '7d',
        },
      }) as any,
    }),
  ],
  providers: [AuthService, JwtStrategy, LocalStrategy, TokenRefreshInterceptor, WsTokenRefreshInterceptor],
  exports: [AuthService, JwtModule, TokenRefreshInterceptor, WsTokenRefreshInterceptor],
})
export class AuthModule {}
