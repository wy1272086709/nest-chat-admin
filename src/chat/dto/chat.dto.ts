import { MessageType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';

export class CreateGroupRoomDto {
  @IsNotEmpty({ message: '群聊名称不能为空' })
  @IsString({ message: '群聊名称必须是字符串' })
  name: string;

  @IsOptional()
  @IsString({ message: '群聊描述必须是字符串' })
  description?: string;

  @IsOptional()
  @IsArray({ message: '成员ID列表必须是数组' })
  @IsString({ each: true, message: '成员ID必须是字符串' })
  memberIds?: string[];
}

/**
 * 消息内容通用校验（文本 / 图片 / 文件 / 音视频）。
 * - 文本类（TEXT 或不传）：content 必填
 * - 非文本类（IMAGE / FILE / AUDIO / VIDEO）：fileUrl 必填
 * 通过 ValidateIf 按 messageType 动态决定哪些字段必填，避免出现「空文本」或「无地址的图片」。
 */
export abstract class MessageContentDto {
  @IsOptional()
  @IsEnum(MessageType, { message: '消息类型不合法' })
  messageType?: MessageType;

  // 文本消息必须有内容
  @ValidateIf((o) => !o.messageType || o.messageType === MessageType.TEXT)
  @IsNotEmpty({ message: '文本消息内容不能为空' })
  @IsString({ message: '消息内容必须是字符串' })
  content?: string;

  // 非文本消息（图片/文件/音视频）必须有文件访问地址
  @ValidateIf((o) => !!o.messageType && o.messageType !== MessageType.TEXT)
  @IsNotEmpty({ message: '非文本消息必须提供 fileUrl' })
  @IsString()
  fileUrl?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsInt({ message: '文件大小必须是整数' })
  @Min(0)
  fileSize?: number;

  @IsOptional()
  @IsString()
  fileType?: string;

  // ===== 媒体扩展字段（图片/音视频常用）=====
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  mediaWidth?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  mediaHeight?: number;

  @IsOptional()
  @IsInt({ message: '时长必须是整数' })
  @Min(0)
  duration?: number;
}

export class SendRoomMessageDto extends MessageContentDto {
  @IsNotEmpty({ message: '房间ID不能为空' })
  @IsString({ message: '房间ID必须是字符串' })
  roomId: string;
}

export class SendPrivateMessageDto extends MessageContentDto {
  @IsNotEmpty({ message: '接收者ID不能为空' })
  @IsString({ message: '接收者ID必须是字符串' })
  receiverId: string;
}

/** 发起 / 获取与某用户的私聊会话（仅建联，不发消息） */
export class InitPrivateRoomDto {
  @IsNotEmpty({ message: '接收者ID不能为空' })
  @IsString({ message: '接收者ID必须是字符串' })
  receiverId: string;
}

export class RoomIdDto {
  @IsNotEmpty({ message: '房间ID不能为空' })
  @IsString({ message: '房间ID必须是字符串' })
  roomId: string;
}

export class GetMessagesDto extends RoomIdDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '分页大小必须是整数' })
  @Min(1)
  @Max(100)
  take?: number;
}

/** HTTP 历史消息查询参数（roomId 走 path param，这里只放分页） */
export class HistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '分页大小必须是整数' })
  @Min(1)
  @Max(100)
  take?: number;
}
