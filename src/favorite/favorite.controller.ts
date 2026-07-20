import {
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ChatUser } from "@prisma/client";
import { CurrentUser } from "@/common/auth/decorators/current-user.decorator";
import {
  CreateFavoriteDto,
  FavoriteQueryDto,
  RemoveFavoriteDto,
} from "./dto/favorite.dto";
import { FavoriteService } from "./favorite.service";

@ApiTags("Favorite")
@Controller("favorites")
export class FavoriteController {
  private readonly logger = new Logger(FavoriteController.name);

  constructor(private readonly favoriteService: FavoriteService) {}

  @Get()
  @ApiOperation({ description: "获取当前用户的收藏列表，可按类型过滤" })
  async list(@CurrentUser() user: ChatUser, @Query() query: FavoriteQueryDto) {
    try {
      const data = await this.favoriteService.list(user.id, query);
      return { message: "收藏列表获取成功", result: true, data };
    } catch (error) {
      this.logger.error(error);
      if (error instanceof HttpException) throw error;
      throw error;
    }
  }

  @Post()
  @ApiOperation({ description: "新增收藏。收藏变化不触发通知推送。" })
  async create(@CurrentUser() user: ChatUser, @Body() dto: CreateFavoriteDto) {
    try {
      const data = await this.favoriteService.create(user.id, dto);
      return { message: "收藏成功", result: true, data };
    } catch (error) {
      this.logger.error(error);
      if (error instanceof HttpException) throw error;
      throw error;
    }
  }

  @Post("remove")
  @ApiOperation({ description: "取消收藏。收藏变化不触发通知推送。" })
  async remove(@CurrentUser() user: ChatUser, @Body() dto: RemoveFavoriteDto) {
    try {
      const data = await this.favoriteService.remove(user.id, dto);
      return { message: "取消收藏成功", result: true, data };
    } catch (error) {
      this.logger.error(error);
      if (error instanceof HttpException) throw error;
      throw error;
    }
  }
}
