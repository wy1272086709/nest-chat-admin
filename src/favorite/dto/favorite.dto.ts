import { FavoriteType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateFavoriteDto {
  @IsEnum(FavoriteType, { message: '收藏类型不合法' })
  type: FavoriteType;

  @IsNotEmpty({ message: '收藏目标ID不能为空' })
  @IsString({ message: '收藏目标ID必须是字符串' })
  targetId: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  sourceName?: string;

  @IsOptional()
  @IsString()
  roomId?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
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
  @IsInt()
  @Min(0)
  duration?: number;

  @IsOptional()
  @IsObject()
  extra?: Record<string, unknown>;
}

export class FavoriteQueryDto {
  @IsOptional()
  @IsEnum(FavoriteType, { message: '收藏类型不合法' })
  type?: FavoriteType;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '分页大小必须是整数' })
  @Min(1)
  @Max(100)
  take?: number;
}

export class RemoveFavoriteDto {
  @IsEnum(FavoriteType, { message: '收藏类型不合法' })
  type: FavoriteType;

  @IsNotEmpty({ message: '收藏目标ID不能为空' })
  @IsString({ message: '收藏目标ID必须是字符串' })
  targetId: string;
}
