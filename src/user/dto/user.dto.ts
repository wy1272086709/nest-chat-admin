import { IsEmail, IsNotEmpty, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '@/prisma/enum';
import { Match } from '@/common/decorators/match.decorator';

export class CreateUserDto {
  @ApiProperty({ description: 'Username' })
  @IsNotEmpty()
  @IsString({ message: '用户名不能为空' })
  username: string;

  @ApiProperty({ description: 'Email address' })
  @IsNotEmpty()
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @ApiProperty({ description: 'nickname' })
  @IsNotEmpty()
  @IsString({ message: '昵称不能为空' })
  nickname: string;

  @ApiProperty({ description: 'Password' })
  @IsNotEmpty()
  @IsString({ message: '密码不能为空' })
  @MinLength(6, { message: '密码长度不能小于 6 个字符' })
  password: string;

  @ApiProperty({ description: 'Confirm Password' })
  @IsNotEmpty()
  @IsString({ message: '确认密码不能为空' })
  @Match('password', { message: '确认密码和密码不一致' })
  confirmPassword: string;

  @ApiProperty({ description: 'Avatar URL', required: false })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiProperty({ description: 'User bio', required: false })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiProperty({ description: 'Verification code', required: false })
  @IsNotEmpty()
  @IsString({ message: '验证码不能为空' })
  code: string;
}

export class UpdateUserDto {
  @ApiProperty({ description: 'Username', required: false })
  @IsOptional()
  @IsString({ message: '用户名不能为空' })
  username?: string;

  @ApiProperty({ description: 'Email address', required: false })
  @IsOptional()
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email?: string;

  @ApiProperty({ description: 'Password', required: false })
  @IsOptional()
  @IsString()
  @MinLength(6, { message: '密码长度不能小于 6 个字符' })
  password?: string;

  @ApiProperty({ description: 'Avatar URL', required: false })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiProperty({ description: 'User bio', required: false })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiProperty({ description: 'User status', required: false })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

export class LoginDto {
  @ApiProperty({ description: 'Email address or Username' })
  @IsNotEmpty()
  account: string;

  @ApiProperty({ description: 'Password' })
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ description: 'Verification code' })
  @IsNotEmpty()
  @IsString()
  verificationCode: string;
}

export class UserResponseDto {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string;
  bio?: string;
  status: UserStatus;
  role: {
    id: string;
    name: string;
    description?: string;
  };
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}