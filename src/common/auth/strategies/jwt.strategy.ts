import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../services/auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => AuthService))
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret'),
    });
  }

  /**
   * JWT验证回调函数
   * @param payload JWT payload，包含 { sub: userId, email: string, username: string, iat: timestamp, exp: timestamp }
   * @returns 用户信息
   */
  async validate(payload: any) {
    // payload包含: { sub: userId, email: string, username: string, iat: timestamp, exp: timestamp }
    const user = await this.authService.validatePayload(payload);
    return {
      ...user,
      tokenJti: payload.jti,
    };
  }
}
