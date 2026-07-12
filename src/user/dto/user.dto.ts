import { IsEmail, IsNotEmpty, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { Match } from '@/common/validation/decorators/match.decorator';

/**
 * 邮件验证码类型枚举
 */
export enum EmailVerificationType {
  REGISTER = 'register',
  FORGET_PASSWORD = 'forgetPassword'
}

export class SendEmailDto {
  @ApiProperty({ description: '接收验证码的邮箱地址' })
  @IsNotEmpty({ message: '邮箱地址不能为空' })
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  to: string;

  @ApiProperty({
    description: '验证码类型',
    enum: EmailVerificationType,
    example: EmailVerificationType.REGISTER
  })

  @IsNotEmpty({ message: '验证码类型不能为空' })
  @IsEnum(EmailVerificationType, { message: '验证码类型必须是 register 或 forgetPassword' })
  type: EmailVerificationType;
}

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

export class ForgetPasswordDto {
  @ApiProperty({ description: '用户名' })
  @IsNotEmpty({ message: '用户名不能为空' })
  username: string;  

  @ApiProperty({ description: '邮箱' })
  @IsNotEmpty({ message: '邮箱不能为空' })
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @ApiProperty({ description: '验证码' })
  @IsNotEmpty({ message: '验证码不能为空' })
  code: string; 
  
  @ApiProperty({ description: '新密码' })
  @IsNotEmpty({ message: '新密码不能为空' })
  @IsString({ message: '新密码不能为空' })
  @MinLength(6, { message: '新密码长度不能小于 6 个字符' })
  password: string;

  @ApiProperty({ description: '确认新密码' })
  @IsNotEmpty({ message: '确认新密码不能为空' })
  @IsString({ message: '确认新密码不能为空' }) 
  @Match('password', { message: '确认新密码和新密码不一致' })
  confirmPassword: string;
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

  @ApiProperty({ description: 'nickname', required: false })
  @IsNotEmpty({ message: '昵称不能为空' })
  @IsString()
  nickname: string;

  @ApiProperty({ description: 'Avatar URL', required: false })
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}

export class LoginDto {
  @ApiProperty({ description: '邮箱或用户名' })
  @IsNotEmpty({ message: '邮箱或用户名不能为空' })
  account: string;

  @ApiProperty({ description: 'Password' })
  @IsNotEmpty({ message: '密码不能为空' })
  @IsString({ message: '密码不能为空' })
  @MinLength(6, { message: '密码长度不能小于 6 个字符' })
  password: string;
}

export class SearchDto {
  @ApiProperty({ description: '搜索查询' })
  @IsNotEmpty({ message: '搜索查询不能为空' })
  query: string;
}

export class ChangeUserStatusDto {
  @ApiProperty({ description: '用户状态', enum: UserStatus, example: UserStatus.BANNED })
  @IsEnum(UserStatus, { message: '用户状态必须是 ACTIVE、INACTIVE 或 BANNED' })
  status: UserStatus;
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

export class AddFriendDto {
  @ApiProperty({ description: '接收好友申请的用户ID' })
  @IsNotEmpty({ message: '接收者ID不能为空' })
  @IsString({ message: '接收者ID必须是字符串' })
  receiverId: string;

  @ApiProperty({ description: '好友申请备注', required: false })
  @IsOptional()
  @IsString({ message: '好友申请备注必须是字符串' })
  message?: string;
}

export class RemoveFriendDto {
  @ApiProperty({ description: '要删除的好友用户ID' })
  @IsNotEmpty({ message: '好友ID不能为空' })
  @IsString({ message: '好友ID必须是字符串' })
  friendId: string;
}
