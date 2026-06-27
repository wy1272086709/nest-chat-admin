import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export enum FriendRequestAction {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

export class HandleFriendRequestDto {
  @ApiProperty({ description: '通知ID' })
  @IsNotEmpty({ message: '通知ID不能为空' })
  @IsString({ message: '通知ID必须是字符串' })
  notificationId: string;

  @ApiProperty({ description: '处理结果', enum: FriendRequestAction })
  @IsNotEmpty({ message: '处理结果不能为空' })
  @IsEnum(FriendRequestAction, { message: '处理结果必须是 ACCEPTED 或 REJECTED' })
  action: FriendRequestAction;
}

export class MarkNotificationReadDto {
  @ApiProperty({ description: '通知ID' })
  @IsNotEmpty({ message: '通知ID不能为空' })
  @IsString({ message: '通知ID必须是字符串' })
  notificationId: string;
}
